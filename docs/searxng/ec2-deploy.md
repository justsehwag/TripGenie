# Deploy SearXNG on EC2 with Caddy (sslip.io hostname)

Template: `docs/searxng/ec2-searxng.yaml` (CloudFormation). Deployed as stack `tripgenie-searxng` in ap-south-1. It creates:

- One t4g.small instance (Graviton, Amazon Linux 2023), CPU credits set to `standard` so there is no surplus-credit billing.
- IMDSv2 required, encrypted 16 GB gp3 root volume, automatic OS security updates.
- No SSH port. Access is through Session Manager only.
- A security group that allows only 80 (Let's Encrypt challenge and redirect) and 443.
- No Elastic IP (the account limit in ap-south-1 is used up). The hostname comes from the instance public IP, for example `65-2-11-149.sslip.io`, and Caddy gets a Let's Encrypt certificate for it automatically. The IP only changes if the instance is stopped and started. Setup re-runs on every boot and picks up the new name, but you then need to update `SEARXNG_BASE_URL`.
- SearXNG with no host port, reachable only through Caddy. Caddy returns 403 unless the secret header matches.
- An IAM role that can read only the one SSM parameter holding the secret.
- The tags the account FinOps policy requires on EC2: lowercase `owner` (an @ingrammicro.com address), `activity` and `autoschedule` (`false` keeps the instance always on).

The secret is read from SSM Parameter Store at boot. It is never in the template, the user data or the stack outputs.

## Before you start

- AWS CLI v2 signed in to the target account.
- A VPC with a PUBLIC subnet that auto-assigns public IPv4 addresses. The default VPC works.

## 1. Create the shared secret

Generate a random value (letters and digits only):

```powershell
$secret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
aws ssm put-parameter --region ap-south-1 --name /tripgenie/searxng/header-secret --type SecureString --value $secret
```

Keep `$secret` for step 5. Do not commit it.

## 2. Find your VPC and public subnet

```powershell
aws ec2 describe-vpcs --region ap-south-1 --filters Name=isDefault,Values=true --query "Vpcs[].VpcId"
aws ec2 describe-subnets --region ap-south-1 --filters Name=vpc-id,Values=<vpc-id> --query "Subnets[?MapPublicIpOnLaunch].SubnetId"
```

## 3. Deploy the stack

```powershell
aws cloudformation deploy --region ap-south-1 `
  --stack-name tripgenie-searxng `
  --template-file docs/searxng/ec2-searxng.yaml `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides VpcId=<vpc-id> SubnetId=<subnet-id> `
  --tags owner=<you>@ingrammicro.com activity=tripgenie autoschedule=false

aws cloudformation describe-stacks --region ap-south-1 --stack-name tripgenie-searxng --query "Stacks[0].Outputs"
```

The IAM instance profile can take up to about 10 minutes to finish. Setup inside the instance (Docker install, image pulls, certificate) takes another 3 to 5 minutes.

## 4. Test it

```powershell
$base = "<SearxngBaseUrl output>"
# Without the header: expect 403
curl.exe -s -o NUL -w "%{http_code}`n" "$base/search?q=goa&format=json"
# With the header: expect 200 and JSON results
curl.exe -s -H "X-TripGenie-Search-Key: $secret" "$base/search?q=goa&format=json"
```

## 5. Point the app at it

In `.env.local` (and on the Amplify app, followed by a redeploy):

```
SEARXNG_BASE_URL=<SearxngBaseUrl output>
SEARXNG_SECRET_HEADER_NAME=X-TripGenie-Search-Key
SEARXNG_SECRET_HEADER_VALUE=<the secret from step 1>
TRIPGENIE_SEARXNG_ENABLED=true
```

Restart `npm run dev`. The server log should show `[searxng-grounding] status=ok` (or `partial`) when you generate an itinerary.

## Operating it

- Shell access: `aws ssm start-session --region ap-south-1 --target <InstanceId>`
- Setup log: `sudo cat /var/log/searxng-setup.log`
- Current hostname: `cat /opt/searxng/hostname`
- Container logs: `sudo docker logs caddy` and `sudo docker logs searxng`
- Update images: `sudo docker pull searxng/searxng:latest`, then `sudo systemctl restart searxng-setup.service`.
- Rotate the secret: update the SSM parameter, run `sudo systemctl restart searxng-setup.service`, then update the app variable.
- Remove everything: `aws cloudformation delete-stack --region ap-south-1 --stack-name tripgenie-searxng`, then delete the SSM parameter.

## Known limits

- Search engines often rate-limit or CAPTCHA cloud IP addresses. Some engines may return little or irrelevant results; Bing in particular returned off-topic results in testing. The app sanitises results and falls back to ungrounded itineraries when search fails.
- The certificate depends on sslip.io resolving and on Let's Encrypt rate limits. If HTTPS fails, check `docker logs caddy`.
- The instance and its public IPv4 address are billed while the stack exists. Check current EC2 and public IPv4 pricing for your region.
- The secret header value must be letters and digits only (Caddy header matching treats `*` as a wildcard).
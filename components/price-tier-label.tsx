import type { Activity } from "@/lib/types";
import { priceTierText } from "@/lib/price-tier-text";

interface PriceTierLabelProps {
  activity: Activity | null | undefined;
}

/** Small badge showing which price tier a Stop's price comes from. */
export function PriceTierLabel({ activity }: PriceTierLabelProps) {
  const { tier, text, className } = priceTierText(activity);
  return (
    <span className={className} data-price-tier={tier} aria-label={text}>
      {text}
    </span>
  );
}

export default PriceTierLabel;

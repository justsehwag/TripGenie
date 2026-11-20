import type { ReactNode } from "react";

export type StopDetailsProps = {
  id: string;
  open: boolean;
  children: ReactNode;
};

export function StopDetails({ id, open, children }: StopDetailsProps) {
  return (
    <div id={id} className="stop-row__details" hidden={!open}>
      {children}
    </div>
  );
}

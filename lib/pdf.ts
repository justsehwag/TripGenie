import type { TripDay, TripPricing } from "./types";

/** PDF Exporter (pure, dependency-free) - design section 16. Ported verbatim from TripSaathi lib/pdf.ts. Requirements: 14.1-14.3. */

const clean = (value: string): string =>
  value.normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/([\\()])/g, "\\$1");

const wrap = (value: string, width = 82): string[] => {
  const words = clean(value).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > width) {
      if (line) lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
};

export function buildItineraryPdf(title: string, route: string, days: TripDay[], pricing: TripPricing): Uint8Array {
  const pageLines = days.map((day) => {
    const lines = [`${title} - Day ${day.day}`, `${day.date} | ${day.title}`, route, ""];
    for (const item of day.activities)
      lines.push(...wrap(`${item.time}  ${item.title} - ${item.description} (INR ${item.cost})`));
    lines.push(
      "",
      `Day estimate: INR ${day.total}`,
      `Flight: INR ${pricing.flight} | Stay: INR ${pricing.stay} | Activities: INR ${pricing.activities}`,
      `Gross trip total: INR ${pricing.gross}`,
      pricing.coupon ? `${pricing.coupon} discount: -INR ${pricing.discount}` : "No discount applied",
      `FINAL ITINERARY TOTAL: INR ${pricing.finalPayable}`,
    );
    return lines;
  });
  const objects: string[] = [];
  const pageIds = pageLines.map((_, i) => 4 + i * 2);
  const contentIds = pageLines.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageLines.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = contentIds[index];
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const commands = ["BT", "/F1 11 Tf", "50 742 Td", "14 TL", ...lines.flatMap((line, i) => [`${i ? "T* " : ""}(${clean(line)}) Tj`]), "ET"].join("\n");
    objects[contentId] = `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

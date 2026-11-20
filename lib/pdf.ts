import type { TripDay, TripPricing } from "./types";

/**
 * PDF Exporter — branded, designed, dependency-free (design section 16).
 *
 * Hand-rolls a PDF 1.4 document using only core drawing operators (filled
 * rectangles, strokes, colored text, two Helvetica faces). No external
 * runtime dependency (Req 14.2). Pure byte generator: same signature as before.
 *
 * Palette: emerald #16B982, deep #087F63, orange #FF901F. Requirements 14.1-14.3.
 */

const EMERALD = "0.086 0.725 0.510";
const DEEP = "0.031 0.498 0.388";
const ORANGE = "1 0.565 0.122";
const INK = "0.102 0.122 0.157";
const SLATE = "0.412 0.447 0.498";
const MIST = "0.953 0.969 0.965";
const CARD = "0.976 0.984 0.980";
const WHITE = "1 1 1";
const CREAM = "0.92 0.98 0.96";
const LINE = "0.894 0.918 0.906";

const PAGE_W = 612;
const PAGE_H = 792;
const M = 54;

const esc = (v: string): string =>
  (v == null ? "" : String(v))
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/([\\()])/g, "\\$1");

const wrap = (value: string, width: number): string[] => {
  const words = esc(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
};

const money = (n: number): string => "INR " + Math.round(Number(n) || 0);

class Canvas {
  ops: string[] = [];
  fill(c: string) { this.ops.push(c + " rg"); return this; }
  box(x: number, y: number, w: number, h: number) { this.ops.push(x + " " + y + " " + w + " " + h + " re f"); return this; }
  frame(c: string, x: number, y: number, w: number, h: number, lw = 0.8) {
    this.ops.push(c + " RG " + lw + " w " + x + " " + y + " " + w + " " + h + " re S"); return this;
  }
  hline(c: string, x1: number, y: number, x2: number, lw = 0.6) {
    this.ops.push(c + " RG " + lw + " w " + x1 + " " + y + " m " + x2 + " " + y + " l S"); return this;
  }
  text(x: number, y: number, size: number, font: string, color: string, value: string) {
    this.ops.push("BT " + color + " rg /" + font + " " + size + " Tf 1 0 0 1 " + x + " " + y + " Tm (" + esc(value) + ") Tj ET");
    return this;
  }
  build() { return this.ops.join("\n"); }
}

const DISCLAIMER = "Estimated plan - amounts indicative; no payment taken, no ticket or room issued.";


function chrome(c: Canvas, pageLabel: string): void {
  c.fill(EMERALD).box(0, PAGE_H - 24, PAGE_W, 24);
  c.fill(ORANGE).box(0, PAGE_H - 28, PAGE_W, 4);
  c.text(M, PAGE_H - 17, 10, "F2", WHITE, "Tripsaathi AI");
  c.text(PAGE_W - M - 96, PAGE_H - 17, 8, "F1", WHITE, "AI travel planner");
  c.fill(MIST).box(0, 0, PAGE_W, 28);
  c.hline(LINE, M, 28, PAGE_W - M);
  c.text(M, 10, 7.5, "F1", SLATE, DISCLAIMER);
  c.text(PAGE_W - M - 60, 10, 7.5, "F1", SLATE, pageLabel);
}

function coverContent(title: string, route: string, days: TripDay[], pricing: TripPricing): string {
  const c = new Canvas();
  c.fill(EMERALD).box(0, PAGE_H - 340, PAGE_W, 340);
  c.fill(DEEP).box(0, PAGE_H - 340, PAGE_W, 64);
  c.fill(ORANGE).box(0, PAGE_H - 344, PAGE_W, 4);

  c.text(M, PAGE_H - 64, 14, "F2", WHITE, "Tripsaathi AI");
  c.text(M, PAGE_H - 82, 9.5, "F1", CREAM, "Your AI-designed journey");

  let ty = PAGE_H - 140;
  for (const l of wrap(title, 26).slice(0, 2)) { c.text(M, ty, 30, "F2", WHITE, l); ty -= 34; }
  c.fill(ORANGE).box(M, ty + 8, 68, 5);
  c.text(M, ty - 16, 13, "F1", CREAM, route);

  const span = days.reduce((m, d) => (Number.isInteger(d.day) && d.day > m ? d.day : m), days.length); const nights = Math.max(0, span - 1);
  c.text(M, PAGE_H - 306, 11, "F1", CREAM, span + " day plan   -   " + nights + " night" + (nights === 1 ? "" : "s"));

  const cx = M, cw = PAGE_W - 2 * M, cy = 232, ch = 168;
  c.fill(WHITE).box(cx, cy, cw, ch);
  c.frame(LINE, cx, cy, cw, ch);
  c.fill(EMERALD).box(cx, cy + ch - 6, cw, 6);

  c.text(cx + 22, cy + ch - 34, 10, "F1", SLATE, "ESTIMATED TRIP TOTAL");
  c.text(cx + 22, cy + ch - 76, 30, "F2", DEEP, money(pricing.finalPayable));
  c.hline(LINE, cx + 22, cy + ch - 92, cx + cw - 22);

  c.text(cx + 22, cy + ch - 112, 9.5, "F1", INK, "Flights  " + money(pricing.flight) + "      Stay  " + money(pricing.stay) + "      Activities  " + money(pricing.activities));
  c.text(cx + 22, cy + ch - 130, 9.5, "F1", SLATE, "Gross  " + money(pricing.gross));
  const disc = pricing.coupon ? pricing.coupon + " discount   -" + money(pricing.discount) : "No discount applied";
  c.text(cx + 22, cy + ch - 148, 9.5, "F1", pricing.coupon ? DEEP : SLATE, disc);

  chrome(c, "Cover");
  return c.build();
}

function dayContent(title: string, route: string, day: TripDay): string {
  const c = new Canvas();
  const headY = PAGE_H - 44 - 78;
  c.fill(EMERALD).box(0, headY, PAGE_W, 78);
  c.fill(DEEP).box(M - 20, headY + 14, 50, 50);
  c.text(M - 20 + 12, headY + 32, 20, "F2", WHITE, String(day.day));
  c.text(M + 46, headY + 48, 9, "F1", CREAM, "DAY " + day.day);
  c.text(M + 46, headY + 28, 15, "F2", WHITE, (day.title || "").slice(0, 46));
  c.text(M + 46, headY + 12, 9, "F1", CREAM, day.date + (day.theme ? "   -   " + day.theme : ""));

  let y = headY - 26;
  const rowFill = ["0.98 0.99 0.985", CARD];
  let i = 0;
  for (const a of day.activities) {
    const desc = wrap((a.title || "") + " - " + (a.description || ""), 72);
    const rows = Math.max(1, desc.length);
    const h = 14 + rows * 12;
    c.fill(rowFill[i % 2]).box(M, y - h + 10, PAGE_W - 2 * M, h);
    c.fill(ORANGE).box(M, y - h + 10, 3, h);
    c.text(M + 12, y - 2, 9, "F2", DEEP, a.time || "");
    let dy = y - 2;
    desc.forEach((d, k) => { c.text(M + 64, dy, 9.5, k === 0 ? "F2" : "F1", INK, d); dy -= 12; });
    c.text(PAGE_W - M - 78, y - 2, 9, "F2", DEEP, money(a.cost));
    y -= h + 6;
    i++;
    if (y < 70) break;
  }

  if (i === 0) c.text(M + 12, y - 2, 10, "F1", SLATE, "Free day - no planned activities.");

  c.fill(MIST).box(M, 40, PAGE_W - 2 * M, 22);
  c.fill(ORANGE).box(M, 40, 3, 22);
  c.text(M + 12, 47, 10, "F2", DEEP, "Day " + day.day + " estimate");
  c.text(PAGE_W - M - 90, 47, 11, "F2", DEEP, money(day.total));

  chrome(c, "Day " + day.day);
  return c.build();
}

function summaryContent(title: string, route: string, pricing: TripPricing): string {
  const c = new Canvas();
  const headY = PAGE_H - 44 - 60;
  c.fill(EMERALD).box(0, headY, PAGE_W, 60);
  c.text(M, headY + 32, 18, "F2", WHITE, "Trip summary");
  c.text(M, headY + 14, 9.5, "F1", CREAM, route);

  const rows: Array<[string, string, string]> = [
    ["Flights", money(pricing.flight), INK],
    ["Stay", money(pricing.stay), INK],
    ["Activities", money(pricing.activities), INK],
    ["Gross total", money(pricing.gross), INK],
  ];
  let y = headY - 40;
  let i = 0;
  for (const [label, val] of rows) {
    c.fill(i % 2 ? CARD : "0.98 0.99 0.985").box(M, y - 8, PAGE_W - 2 * M, 26);
    c.text(M + 14, y, 11, i === rows.length - 1 ? "F2" : "F1", INK, label);
    c.text(PAGE_W - M - 110, y, 11, i === rows.length - 1 ? "F2" : "F1", INK, val);
    y -= 32;
    i++;
  }
  const disc = pricing.coupon ? pricing.coupon + " discount" : "No discount applied";
  c.fill(MIST).box(M, y - 8, PAGE_W - 2 * M, 26);
  c.text(M + 14, y, 11, "F1", pricing.coupon ? DEEP : SLATE, disc);
  c.text(PAGE_W - M - 110, y, 11, "F1", pricing.coupon ? DEEP : SLATE, pricing.coupon ? "-" + money(pricing.discount) : money(0));
  y -= 46;

  c.fill(DEEP).box(M, y - 14, PAGE_W - 2 * M, 48);
  c.fill(ORANGE).box(M, y - 14, 5, 48);
  c.text(M + 20, y + 10, 12, "F1", CREAM, "FINAL ITINERARY TOTAL");
  c.text(PAGE_W - M - 150, y + 6, 22, "F2", WHITE, money(pricing.finalPayable));

  chrome(c, "Summary");
  return c.build();
}

export function buildItineraryPdf(title: string, route: string, days: TripDay[], pricing: TripPricing): Uint8Array {
  const streams: string[] = [
    coverContent(title, route, days, pricing),
    ...days.map((d) => dayContent(title, route, d)),
    summaryContent(title, route, pricing),
  ];

  const objects: string[] = [];
  const pageIds = streams.map((_, i) => 5 + i * 2);
  const contentIds = streams.map((_, i) => 6 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [" + pageIds.map((id) => id + " 0 R").join(" ") + "] /Count " + pageIds.length + " >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  streams.forEach((s, index) => {
    const pageId = pageIds[index];
    const contentId = contentIds[index];
    objects[pageId] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + contentId + " 0 R >>";
    objects[contentId] = "<< /Length " + s.length + " >>\nstream\n" + s + "\nendstream";
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += id + " 0 obj\n" + objects[id] + "\nendobj\n";
  }
  const xref = pdf.length;
  pdf += "xref\n0 " + objects.length + "\n0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id++)
    pdf += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer\n<< /Size " + objects.length + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return new TextEncoder().encode(pdf);
}

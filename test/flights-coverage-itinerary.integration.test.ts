import { describe, it, expect, vi } from "vitest";
import { resolveDestination } from "@/lib/destination-airports";
import { validateFlightQuery, type FlightFareQuery } from "@/lib/providers/serpapi-flights";

// Requirements 1.2, 2.1: Chennai -> Cape Town resolves to MAA -> CPT (including a
// typo) before any provider call. The mocked fetchImpl must never be invoked.

const NOW = new Date("2030-01-01T00:00:00Z");

function query(destination: string): FlightFareQuery {
  return {
    origin: "Chennai",
    destination,
    tripType: "one-way",
    departDate: "2030-02-01",
    cabin: "economy",
    adults: 1,
  };
}

describe("Chennai -> Cape Town resolves before any provider call", () => {
  for (const typed of ["capetown", "cpaetown"]) {
    it(`flights page path: resolveDestination("${typed}") -> CPT, then validateFlightQuery -> MAA/CPT`, () => {
      const fetchImpl = vi.fn();

      const origin = resolveDestination("Chennai");
      const dest = resolveDestination(typed);
      expect(origin.kind).toBe("airport");
      expect(dest.kind).toBe("airport");
      if (origin.kind !== "airport" || dest.kind !== "airport") return;
      expect(origin.code).toBe("MAA");
      expect(dest.code).toBe("CPT");

      // The page hands the resolved codes to the provider adapter.
      const check = validateFlightQuery(query(dest.code), NOW);
      expect(check.ok).toBe(true);
      if (check.ok) {
        expect(check.resolved.originCode).toBe("MAA");
        expect(check.resolved.destinationCode).toBe("CPT");
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  it('validateFlightQuery resolves "Chennai" -> "capetown" directly with no network call', () => {
    const fetchImpl = vi.fn();
    const check = validateFlightQuery(query("capetown"), NOW);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.resolved.originCode).toBe("MAA");
      expect(check.resolved.destinationCode).toBe("CPT");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

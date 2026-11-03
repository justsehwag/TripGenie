/**
 * Example tests for filter pills, clear-all and arrangeCars
 * (lib/results-view.ts section 5, task 3.9). Property tests for these live in
 * test/results-view.test.ts (tasks 3.10, 3.11).
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_STAYS_VIEW,
  DEFAULT_FLIGHTS_VIEW,
  DEFAULT_CARS_VIEW,
  activeFilterPills,
  staysFilterPills,
  flightsFilterPills,
  clearStaysFilters,
  clearFlightsFilters,
  clearAllFilters,
  arrangeCars,
  type StaysView,
  type FlightsView,
} from "../lib/results-view";
import type { CarOffer } from "../lib/types";

describe("staysFilterPills", () => {
  it("returns no pills for the default view", () => {
    expect(staysFilterPills(DEFAULT_STAYS_VIEW)).toEqual([]);
  });

  it("labels each active filter and removes only that value", () => {
    const v: StaysView = {
      sort: "price-asc",
      style: "Comfort",
      minPrice: 2000,
      maxPrice: 8000,
      minRating: 4,
      freeCancel: true,
      show: 20,
    };
    const snapshot = JSON.stringify(v);
    const pills = staysFilterPills(v);
    expect(pills.map((p) => p.id)).toEqual(["style", "minPrice", "maxPrice", "minRating", "freeCancel"]);
    expect(pills.map((p) => p.label)).toEqual([
      "Comfort stays",
      "\u20B92,000+",
      "Up to \u20B98,000",
      "Rating 4.0+",
      "Free cancellation",
    ]);
    expect(pills[1].remove()).toEqual({ ...v, minPrice: null });
    expect(pills[3].remove()).toEqual({ ...v, minRating: 0 });
    expect(JSON.stringify(v)).toBe(snapshot);
  });

  it("formats large amounts with en-IN grouping", () => {
    const pills = staysFilterPills({ ...DEFAULT_STAYS_VIEW, maxPrice: 150000 });
    expect(pills[0].label).toBe("Up to \u20B91,50,000");
  });

  it("clear-all keeps the sort and resets filters and show", () => {
    const v: StaysView = { ...DEFAULT_STAYS_VIEW, sort: "rating", style: "Luxury", freeCancel: true, show: 30 };
    expect(clearStaysFilters(v)).toEqual({ ...DEFAULT_STAYS_VIEW, sort: "rating" });
    expect(clearAllFilters(v)).toEqual({ ...DEFAULT_STAYS_VIEW, sort: "rating" });
  });
});

describe("flightsFilterPills", () => {
  const v: FlightsView = {
    sort: "fastest",
    stops: ["0", "2"],
    airlines: ["Air India", "IndiGo"],
    windows: ["morning"],
    maxFare: 12500,
    show: 10,
  };

  it("returns one pill per list member plus max fare", () => {
    const pills = flightsFilterPills(v);
    expect(pills.map((p) => p.id)).toEqual([
      "stops:0",
      "stops:2",
      "airline:Air India",
      "airline:IndiGo",
      "window:morning",
      "maxFare",
    ]);
    expect(pills.map((p) => p.label)).toEqual([
      "Non-stop",
      "2+ stops",
      "Air India",
      "IndiGo",
      "Morning (6am\u201312pm)",
      "Up to \u20B912,500 per person",
    ]);
  });

  it("removes a single list member", () => {
    const pills = activeFilterPills(v);
    expect(pills[1].remove()).toEqual({ ...v, stops: ["0"] });
    expect(pills[2].remove()).toEqual({ ...v, airlines: ["IndiGo"] });
    expect(pills[4].remove()).toEqual({ ...v, windows: [] });
  });

  it("clear-all keeps the sort", () => {
    expect(clearFlightsFilters(v)).toEqual({ ...DEFAULT_FLIGHTS_VIEW, sort: "fastest" });
    expect(flightsFilterPills(clearAllFilters(v))).toEqual([]);
  });
});

describe("arrangeCars", () => {
  const car = (id: string, carClass: string, transmission: "automatic" | "manual", seats: number, pricePerDay: number): CarOffer =>
    ({
      id,
      meta: { provenance: "estimated" } as unknown as CarOffer["meta"],
      pickupLocation: "Goa",
      dropoffLocation: "Goa",
      carClass,
      transmission,
      seats,
      days: 3,
      pricePerDay,
    });
  const offers = [
    car("a", "SUV", "automatic", 7, 3500),
    car("b", "Economy", "manual", 4, 1200),
    car("c", "Luxury", "automatic", 5, 6000),
    car("d", "Compact", "manual", 5, 1800),
  ];

  it("sorts by price ascending by default", () => {
    expect(arrangeCars(offers, DEFAULT_CARS_VIEW).map((o) => o.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("sorts by seats descending, stable on ties", () => {
    expect(arrangeCars(offers, { ...DEFAULT_CARS_VIEW, sort: "seats" }).map((o) => o.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("sorts by class name", () => {
    expect(arrangeCars(offers, { ...DEFAULT_CARS_VIEW, sort: "class" }).map((o) => o.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("filters by class and transmission without mutating input", () => {
    const ids = offers.map((o) => o.id);
    expect(arrangeCars(offers, { sort: "price", carClass: null, transmission: "manual" }).map((o) => o.id)).toEqual(["b", "d"]);
    expect(arrangeCars(offers, { sort: "price", carClass: "SUV", transmission: "manual" })).toEqual([]);
    expect(offers.map((o) => o.id)).toEqual(ids);
  });
});

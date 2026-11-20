"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTripContext } from "@/components/trip-context";
import { todayIst } from "@/lib/ist-time";
import {
  BUDGET_LEVELS,
  MAX_ADULTS,
  MAX_CHILDREN,
  MIN_ADULTS,
  MIN_CHILDREN,
  QUICK_FORM_MESSAGES,
  VIBE_CHIPS,
  canGenerate,
  contextToQuickForm,
  exceedsMaxDays,
  missingRequired,
  quickFormToWrite,
  validateQuickForm,
  type BudgetLevel,
  type QuickFormField,
  type QuickFormValues,
} from "@/lib/quick-form";

const BUDGET_LABELS: Record<BudgetLevel, string> = {
  budget: "Budget",
  mid: "Mid-range",
  luxury: "Luxury",
};

type BlurKey = QuickFormField | "adults" | "children";

function toCount(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * One-screen trip form. Writes the same Shared_Trip_Context the chat uses,
 * then hands off to /trip where the Planner generates the itinerary.
 */
export default function QuickForm() {
  const router = useRouter();
  const trip = useTripContext();
  const { context, dates, patchContext, patchDates, setUserInitiated } = trip;

  const [values, setValues] = useState<QuickFormValues>(() => contextToQuickForm(context, dates));
  const [dirty, setDirty] = useState(false);
  const [blurred, setBlurred] = useState<Partial<Record<BlurKey, boolean>>>({});
  const [submitError, setSubmitError] = useState(false);

  // Adopt late-arriving (hydrated) context only while the form is untouched.
  useEffect(() => {
    if (dirty) return;
    setValues(contextToQuickForm(context, dates));
  }, [context, dates, dirty]);

  const today = todayIst();
  const errors = validateQuickForm(values, today);
  const missing = missingRequired(values);
  const ready = canGenerate(values, today);

  function update(patch: Partial<QuickFormValues>) {
    setDirty(true);
    setSubmitError(false);
    setValues((prev) => ({ ...prev, ...patch }));
  }
  function blur(key: BlurKey) {
    setBlurred((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }

  function fieldError(field: QuickFormField): string | undefined {
    const shown =
      field === "travellers" ? blurred.adults || blurred.children : blurred[field];
    if (!shown) return undefined;
    if (field !== "travellers" && missing.includes(field)) return QUICK_FORM_MESSAGES.required;
    return errors[field];
  }

  const errOrigin = fieldError("origin");
  const errDestination = fieldError("destination");
  const errDepart = fieldError("departDate");
  const errReturn = fieldError("returnDate");
  const errTravellers = fieldError("travellers");
  const longTrip = exceedsMaxDays(values.departDate, values.returnDate);

  function toggleVibe(vibe: string) {
    update({
      vibes: values.vibes.includes(vibe)
        ? values.vibes.filter((v) => v !== vibe)
        : [...values.vibes, vibe],
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canGenerate(values, todayIst())) {
      setBlurred({
        origin: true,
        destination: true,
        departDate: true,
        returnDate: true,
        adults: true,
        children: true,
      });
      return;
    }
    try {
      const write = quickFormToWrite(values);
      patchContext(write.context);
      patchDates(write.dates);
      setUserInitiated(true);
      router.push("/trip");
    } catch {
      setSubmitError(true);
    }
  }

  return (
    <form className="quick-form card" onSubmit={onSubmit} noValidate aria-label="Quick trip form">
      <label className="field quick-form__field">
        <span>From</span>
        <input
          type="text"
          name="origin"
          autoComplete="off"
          value={values.origin}
          onChange={(e) => update({ origin: e.target.value })}
          onBlur={() => blur("origin")}
          aria-required="true"
          aria-invalid={errOrigin ? true : undefined}
          aria-describedby={errOrigin ? "quick-err-origin" : undefined}
        />
        {errOrigin && (
          <small id="quick-err-origin" className="field-error">
            {errOrigin}
          </small>
        )}
      </label>

      <label className="field quick-form__field">
        <span>To</span>
        <input
          type="text"
          name="destination"
          autoComplete="off"
          value={values.destination}
          onChange={(e) => update({ destination: e.target.value })}
          onBlur={() => blur("destination")}
          aria-required="true"
          aria-invalid={errDestination ? true : undefined}
          aria-describedby={errDestination ? "quick-err-destination" : undefined}
        />
        {errDestination && (
          <small id="quick-err-destination" className="field-error">
            {errDestination}
          </small>
        )}
      </label>

      <label className="field quick-form__field">
        <span>Departure date</span>
        <input
          type="date"
          name="departDate"
          min={today}
          value={values.departDate}
          onChange={(e) => update({ departDate: e.target.value })}
          onBlur={() => blur("departDate")}
          aria-required="true"
          aria-invalid={errDepart ? true : undefined}
          aria-describedby={errDepart ? "quick-err-depart" : undefined}
        />
        {errDepart && (
          <small id="quick-err-depart" className="field-error">
            {errDepart}
          </small>
        )}
      </label>

      <label className="field quick-form__field">
        <span>Return date</span>
        <input
          type="date"
          name="returnDate"
          min={values.departDate || today}
          value={values.returnDate}
          onChange={(e) => update({ returnDate: e.target.value })}
          onBlur={() => blur("returnDate")}
          aria-required="true"
          aria-invalid={errReturn ? true : undefined}
          aria-describedby={
            [errReturn ? "quick-err-return" : "", longTrip ? "quick-help-long" : ""]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        {errReturn && (
          <small id="quick-err-return" className="field-error">
            {errReturn}
          </small>
        )}
        {longTrip && (
          <small id="quick-help-long" className="quick-form__help">
            The itinerary covers the first 30 days
          </small>
        )}
      </label>

      <label className="field quick-form__field">
        <span>Adults</span>
        <input
          type="number"
          name="adults"
          inputMode="numeric"
          min={MIN_ADULTS}
          max={MAX_ADULTS}
          value={values.adults}
          onChange={(e) => update({ adults: toCount(e.target.value, MIN_ADULTS, MAX_ADULTS) })}
          onBlur={() => blur("adults")}
          aria-invalid={errTravellers ? true : undefined}
          aria-describedby={errTravellers ? "quick-err-travellers" : undefined}
        />
      </label>

      <label className="field quick-form__field">
        <span>Children</span>
        <input
          type="number"
          name="children"
          inputMode="numeric"
          min={MIN_CHILDREN}
          max={MAX_CHILDREN}
          value={values.children}
          onChange={(e) => update({ children: toCount(e.target.value, MIN_CHILDREN, MAX_CHILDREN) })}
          onBlur={() => blur("children")}
          aria-invalid={errTravellers ? true : undefined}
          aria-describedby={errTravellers ? "quick-err-travellers" : undefined}
        />
        {errTravellers && (
          <small id="quick-err-travellers" className="field-error">
            {errTravellers}
          </small>
        )}
      </label>

      <fieldset className="quick-form__group">
        <legend>Budget level</legend>
        <div className="quick-form__options" role="radiogroup" aria-label="Budget level">
          {BUDGET_LEVELS.map((level) => (
            <label key={level} className="field quick-form__radio">
              <input
                type="radio"
                name="budgetLevel"
                value={level}
                checked={values.budgetLevel === level}
                onChange={() => update({ budgetLevel: level })}
              />
              <span>{BUDGET_LABELS[level]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="quick-form__group">
        <legend>Vibes</legend>
        <div className="quick-form__options">
          {VIBE_CHIPS.map((vibe) => {
            const on = values.vibes.includes(vibe);
            return (
              <button
                key={vibe}
                type="button"
                className="chat-chip quick-form__chip"
                aria-pressed={on}
                onClick={() => toggleVibe(vibe)}
              >
                {vibe}
              </button>
            );
          })}
        </div>
      </fieldset>

      {submitError && (
        <div className="quick-form__error" role="alert">
          <p className="field-error">
            Tripsaathi AI could not save your trip details. Please try again.
          </p>
          <button type="submit" className="btn">
            Try again
          </button>
        </div>
      )}

      <button type="submit" className="cta quick-form__submit" disabled={!ready}>
        Generate itinerary
      </button>
    </form>
  );
}

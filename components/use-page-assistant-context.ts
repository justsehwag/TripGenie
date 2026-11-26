"use client";

import { useEffect, useRef } from "react";
import { registerContext } from "@/lib/site-assistant/registry";
import type { PageActionHandlers, PageId } from "@/lib/site-assistant/types";

export interface PageAssistantContextInput {
  page: PageId;
  slot: string;
  summary: string;
  data?: unknown;
  actions?: PageActionHandlers;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Registers a page context slot with the Context_Registry while the calling
 * component is mounted. Re-registers only when page, slot, summary, the set
 * of action names, or the JSON form of `data` change, so inline objects do
 * not cause re-register loops. Action handlers are read from a ref at call
 * time, so the latest handlers always run.
 */
export function usePageAssistantContext(input: PageAssistantContextInput): void {
  const { page, slot, summary, data, actions } = input;

  const latest = useRef(input);
  latest.current = input;

  const dataKey = stringify(data);
  const actionNames = actions ? Object.keys(actions).sort().join("\u0000") : "";

  useEffect(() => {
    const names = actionNames ? actionNames.split("\u0000") : [];
    const proxied: PageActionHandlers = {};
    for (const name of names) {
      proxied[name] = (params: unknown) => {
        const handler = latest.current.actions?.[name];
        return handler ? handler(params) : undefined;
      };
    }
    return registerContext({
      page,
      slot,
      summary,
      data: latest.current.data,
      actions: names.length ? proxied : undefined,
    });
  }, [page, slot, summary, dataKey, actionNames]);
}

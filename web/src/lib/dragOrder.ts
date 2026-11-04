// Drag a session's card or row anywhere in the list. Where it is dropped goes to the server, so every window shows the
// same order. The marks for "it goes here" live on the elements' data attributes: React re-renders the list every
// second, and it leaves attributes it does not know alone.
import { useCallback, useRef } from "react";
import type { Session } from "../../../shared/types.ts";
import { api } from "../store.ts";

type Side = "before" | "after";

/** A ref for the element that holds the cards (`item` finds them in it); `axis` is how they line up. */
export function useDragOrder(sessions: Session[], item: string, axis: "x" | "y"): (el: HTMLElement | null) => void {
  const list = useRef(sessions);
  list.current = sessions;
  const detach = useRef<(() => void) | null>(null);

  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    let dragged: number | null = null;
    let mark: { el: HTMLElement; pid: number; side: Side } | null = null;

    const items = () => [...el.querySelectorAll<HTMLElement>(item)];
    const pidOf = (node: HTMLElement) => Number(node.dataset.pid);
    const unmark = () => {
      if (mark) delete mark.el.dataset.drop;
      mark = null;
    };

    const start = (e: DragEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(item);
      if (!card || !el.contains(card) || !e.dataTransfer) return;
      dragged = pidOf(card);
      card.dataset.dragging = "";
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.querySelector("h3, .focus-row-name")?.textContent ?? "");
    };
    const over = (e: DragEvent) => {
      if (dragged === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      // Over a card: before or after it, by which half the pointer is in. Past the last card: after the last one.
      let card = (e.target as HTMLElement).closest<HTMLElement>(item);
      let side: Side = "after";
      if (card && el.contains(card)) {
        const r = card.getBoundingClientRect();
        side = (axis === "x" ? e.clientX - r.left < r.width / 2 : e.clientY - r.top < r.height / 2) ? "before" : "after";
      } else card = items().at(-1) ?? null;
      if (!card || pidOf(card) === dragged) return unmark();
      if (mark?.el === card && mark.side === side) return;
      unmark();
      mark = { el: card, pid: pidOf(card), side };
      card.dataset.drop = side;
    };
    const drop = (e: DragEvent) => {
      if (dragged === null) return;
      e.preventDefault();
      const target = mark;
      const pid = dragged;
      end();
      if (!target) return;
      // Its new neighbours, in the list as you see it.
      const rest = list.current.filter((s) => s.pid !== pid);
      const at = rest.findIndex((s) => s.pid === target.pid) + (target.side === "after" ? 1 : 0);
      void api(`/api/sessions/${pid}/place`, { above: rest[at - 1]?.pid ?? null, below: rest[at]?.pid ?? null }).catch(() => null);
    };
    const end = () => {
      unmark();
      for (const card of items()) delete card.dataset.dragging;
      dragged = null;
    };
    const leave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) unmark();
    };

    el.addEventListener("dragstart", start);
    el.addEventListener("dragover", over);
    el.addEventListener("drop", drop);
    el.addEventListener("dragend", end);
    el.addEventListener("dragleave", leave);
    detach.current = () => {
      el.removeEventListener("dragstart", start);
      el.removeEventListener("dragover", over);
      el.removeEventListener("drop", drop);
      el.removeEventListener("dragend", end);
      el.removeEventListener("dragleave", leave);
    };
  }, [item, axis]);
}

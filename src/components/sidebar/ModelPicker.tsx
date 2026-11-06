"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import styles from "./Sidebar.module.css";
import { isNarrowViewport } from "@/lib/viewport";

// A disabled item shows, greyed out, but cannot be picked. Items with the same
// `group`, next to each other, show under that heading. An external item runs at
// an outside provider, and shows in the color of links. `fullName` is for an item
// whose label shortens it: it can be searched for, and shows on hover.
export type PickerItem = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  group?: string;
  external?: boolean;
  fullName?: string;
};

/**
 * A select-like button that opens a searchable list, for lists too long for a
 * plain select. The parent owns `open`, so it can also open the list itself.
 */
export default function ModelPicker({
  label,
  items,
  value,
  valueLabel,
  open,
  onOpenChange,
  onPick,
  loading,
  notice,
  noticeIsError,
  emptyText,
  searchPlaceholder,
  disabled,
  triggerClassName,
  openAtTop,
}: {
  label: string;
  items: PickerItem[];
  value: string;
  valueLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (value: string) => void;
  loading?: boolean;
  notice?: string | null;
  noticeIsError?: boolean;
  emptyText: string;
  searchPlaceholder: string;
  disabled?: boolean;
  triggerClassName?: string;
  // Open at the start of the list, even when the current value is further down
  openAtTop?: boolean;
}) {
  const [query, setQuery] = useState("");
  // Item highlighted with the arrow keys or the mouse; null follows the defaults below.
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();
  const isOpen = open && !disabled;

  // Every word of the query must appear in the item.
  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const text = `${item.label} ${item.detail ?? ""} ${item.fullName ?? ""} ${item.group ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [items, query]);

  // Without a highlighted item: the current value, or the first usable match once the user types.
  const activeIndex = Math.max(
    0,
    filtered.findIndex(
      (item) => item.value === (activeValue ?? (query ? filtered.find((match) => !match.disabled)?.value : value))
    )
  );
  const activeItem = filtered[activeIndex];
  const optionId = (index: number) => `${listId}-option-${index}`;

  function close(focusTrigger: boolean) {
    onOpenChange(false);
    setQuery("");
    setActiveValue(null);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function pick(item: PickerItem) {
    onPick(item.value);
    close(true);
  }

  // Focus the search field on open (not on mobile, where focus opens the keyboard).
  useEffect(() => {
    if (isOpen && !isNarrowViewport()) searchRef.current?.focus();
  }, [isOpen]);

  // Keep the highlighted item in view, unless the list is to open at its start
  const stayAtTop = !!openAtTop && !activeValue && !query;
  useEffect(() => {
    if (!isOpen || stayAtTop) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [isOpen, stayAtTop, activeIndex, filtered]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  });

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const move = (step: number) => {
      e.preventDefault();
      // Disabled items are skipped, in the direction of the move
      let index = Math.min(filtered.length - 1, Math.max(0, activeIndex + step));
      while (filtered[index]?.disabled) index += Math.sign(step);
      const next = filtered[index];
      if (next) setActiveValue(next.value);
    };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(10);
    else if (e.key === "PageUp") move(-10);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (activeItem && !activeItem.disabled) pick(activeItem);
    } else if (e.key === "Tab") close(false);
  }

  return (
    <div className={styles.picker} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`${styles.modelSelect} ${styles.pickerTrigger} ${triggerClassName ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`${label}: ${valueLabel}`}
        title={valueLabel}
        onClick={() => (isOpen ? close(false) : onOpenChange(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !isOpen) {
            e.preventDefault();
            onOpenChange(true);
          }
        }}
        disabled={disabled}
      >
        <span className={styles.pickerValue}>{valueLabel}</span>
      </button>

      {isOpen && (
        <div className={styles.pickerPopover}>
          <input
            ref={searchRef}
            type="search"
            className={styles.pickerSearch}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveValue(null);
            }}
            onKeyDown={onSearchKeyDown}
            role="combobox"
            aria-label={searchPlaceholder}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
          />

          {notice && <p className={`${styles.pickerNote} ${noticeIsError ? styles.pickerNoteError : ""}`}>{notice}</p>}
          {loading && <p className={styles.pickerNote}>Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p className={styles.pickerNote}>{query ? "No matches" : emptyText}</p>
          )}

          <ul className={styles.pickerList} id={listId} role="listbox" aria-label={label} ref={listRef}>
            {filtered.map((item, index) => (
              <Fragment key={item.value}>
                {item.group && item.group !== filtered[index - 1]?.group && (
                  <li role="presentation" className={styles.pickerGroup}>
                    {item.group}
                  </li>
                )}
                <li
                  id={optionId(index)}
                  role="option"
                  aria-selected={item.value === value}
                  aria-disabled={item.disabled || undefined}
                  data-active={index === activeIndex && !item.disabled}
                  className={`${styles.pickerOption} ${item.external ? styles.pickerOptionExternal : ""}`}
                  title={item.fullName}
                  // Keep focus in the search field while clicking.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (!item.disabled) setActiveValue(item.value);
                  }}
                  onClick={() => {
                    if (!item.disabled) pick(item);
                  }}
                >
                  <span>{item.label}</span>
                  {item.detail && <span className={styles.pickerDetail}>{item.detail}</span>}
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

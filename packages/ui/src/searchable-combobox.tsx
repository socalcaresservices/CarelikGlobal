import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "./cn";

// The one reusable searchable-select the modernization spec asks for,
// used everywhere a large list (clients, caregivers, services...) would
// otherwise be a giant <select>. Two data modes so one component covers
// both cases:
//   - `options`: a static list, filtered client-side as the user types
//     (fine for small, already-loaded sets like languages or skills).
//   - `onSearch`: an async, debounced lookup - the caller does the
//     organization-scoped Supabase query itself and returns matches, so
//     this component never has to know about Supabase or tenancy. Use
//     this for anything that could be large (clients, caregivers).
// Native ARIA combobox pattern (role="combobox" + listbox), no external
// dependency - matches how the rest of this app's components are built.
export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

export interface SearchableComboboxProps {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options?: ComboboxOption[];
  onSearch?: (query: string) => Promise<ComboboxOption[]>;
  /** Shown as the selected value's label when it isn't present in the
   * current `options`/last search results (e.g. selection made before
   * this render, or restored from saved data). */
  selectedLabel?: string | undefined;
  placeholder?: string;
  debounceMs?: number;
  disabled?: boolean;
  required?: boolean;
  id?: string;
}

export function SearchableCombobox({
  label,
  value,
  onChange,
  options,
  onSearch,
  selectedLabel,
  placeholder = "Type to search…",
  debounceMs = 250,
  disabled,
  required,
  id: providedId
}: SearchableComboboxProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ComboboxOption[]>(options ?? []);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = (options ?? results).find((option) => option.value === value) ?? null;
  const displayLabel = selected?.label ?? (value ? (selectedLabel ?? "") : "");

  useEffect(() => {
    if (!open) return undefined;

    if (onSearch) {
      setLoading(true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSearch(query)
          .then((next) => setResults(next))
          .finally(() => setLoading(false));
      }, debounceMs);
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    const source = options ?? [];
    const q = query.trim().toLowerCase();
    setResults(q ? source.filter((option) => option.label.toLowerCase().includes(q)) : source);
    return undefined;
  }, [query, open, onSearch, options, debounceMs]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function selectOption(option: ComboboxOption) {
    onChange(option.value);
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(results.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = results[activeIndex];
      if (option) selectOption(option);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      <div className="relative mt-1">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          required={required && !value}
          value={open ? query : displayLabel}
          placeholder={placeholder}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 pr-8 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-400"
        />
        {value && !open ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => {
              onChange(null);
              setQuery("");
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        ) : null}
      </div>
      {open ? (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {loading ? (
            <li className="px-3 py-2 text-sm text-slate-400">Searching…</li>
          ) : results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-400">No matches.</li>
          ) : (
            results.map((option, index) => (
              <li
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
                className={cn(
                  "cursor-pointer px-3 py-2 text-sm",
                  index === activeIndex ? "bg-slate-100" : "hover:bg-slate-50",
                  option.value === value ? "font-medium text-slate-950" : "text-slate-700"
                )}
              >
                {option.label}
                {option.description ? (
                  <span className="ml-1.5 text-xs text-slate-400">{option.description}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

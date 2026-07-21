import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ComboboxOption } from "./searchable-combobox";

// Multi-select sibling to SearchableCombobox - same two data modes
// (static `options` filtered client-side, or async debounced
// `onSearch`), but tracks an array of selected values shown as
// removable chips instead of a single value in the input. Used for
// "Services Requested" (a client can have several) and anywhere else
// the spec calls for "select multiple, shown as removable chips/tags".
export interface MultiSelectComboboxProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  options?: ComboboxOption[];
  onSearch?: (query: string) => Promise<ComboboxOption[]>;
  /** Labels for already-selected values not present in `options`/the
   * last search results, keyed by value. */
  selectedLabels?: Record<string, string>;
  placeholder?: string;
  debounceMs?: number;
  disabled?: boolean;
}

export function MultiSelectCombobox({
  label,
  values,
  onChange,
  options,
  onSearch,
  selectedLabels,
  placeholder = "Type to search…",
  debounceMs = 250,
  disabled
}: MultiSelectComboboxProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ComboboxOption[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const known = new Map<string, string>(Object.entries(selectedLabels ?? {}));
  for (const option of options ?? []) known.set(option.value, option.label);

  useEffect(() => {
    if (!open) return undefined;

    if (onSearch) {
      setLoading(true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSearch(query)
          .then((next) => setResults(next.filter((option) => !values.includes(option.value))))
          .finally(() => setLoading(false));
      }, debounceMs);
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }

    const source = (options ?? []).filter((option) => !values.includes(option.value));
    const q = query.trim().toLowerCase();
    setResults(q ? source.filter((option) => option.label.toLowerCase().includes(q)) : source);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open, onSearch, options, debounceMs, values.join(",")]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function addOption(option: ComboboxOption) {
    onChange([...values, option.value]);
    setQuery("");
    setActiveIndex(-1);
  }

  function removeValue(target: string) {
    onChange(values.filter((value) => value !== target));
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
      if (option) addOption(option);
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "Backspace" && query === "" && values.length > 0) {
      removeValue(values[values.length - 1]!);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      <div className="mt-1 flex min-h-[2.5rem] flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1.5 focus-within:border-slate-400">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-xs font-medium text-slate-700"
          >
            {known.get(value) ?? value}
            <button
              type="button"
              aria-label={`Remove ${known.get(value) ?? value}`}
              onClick={() => removeValue(value)}
              disabled={disabled}
              className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder={values.length === 0 ? placeholder : ""}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="min-w-[8rem] flex-1 border-0 bg-transparent p-0.5 text-sm text-slate-900 outline-none disabled:text-slate-400"
        />
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
                aria-selected={false}
                onMouseDown={(event) => {
                  event.preventDefault();
                  addOption(option);
                }}
                className={
                  index === activeIndex
                    ? "cursor-pointer bg-slate-100 px-3 py-2 text-sm text-slate-700"
                    : "cursor-pointer px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                }
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

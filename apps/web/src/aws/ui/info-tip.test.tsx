// The Help control: reachable by mouse, keyboard and touch, dismissible, never blocking, and short. SYNTHETIC text only.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { INFO_TIP_MAX_CHARS, InfoTip } from "./info-tip";

afterEach(cleanup);

const tip = () => screen.getByRole("tooltip", { hidden: true });
const visible = () => !tip().className.split(" ").includes("hidden");

describe("InfoTip", () => {
  it("is named, described for screen readers, closed at first, and shows a title, the text and a further-detail link", () => {
    render(<MemoryRouter><InfoTip label="About Clients" title="Clients" more={{ to: "/clients", label: "Open clients" }}>Manage client profiles and care information.</InfoTip></MemoryRouter>);
    const button = screen.getByRole("button", { name: "About Clients" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAccessibleDescription(/Manage client profiles and care information\./);
    expect(tip()).toHaveTextContent("Clients");
    expect(screen.getByRole("link", { name: "Open clients", hidden: true })).toHaveAttribute("href", "/clients");
    expect(visible()).toBe(false);
  });

  it("opens on click or tap, closes on a second click, on Escape (focus returns to the icon), on its close button, and on a tap elsewhere", () => {
    render(<div><InfoTip label="About Staff">Staff are the people who work for the agency.</InfoTip><button type="button">Elsewhere</button></div>);
    const button = screen.getByRole("button", { name: "About Staff" });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(visible()).toBe(true);
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Close help", hidden: true }));
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(visible()).toBe(false);   // hidden even though the icon keeps focus and the pointer may still rest on it
    fireEvent.click(button);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("is a real button (Tab reaches it, Enter and Space activate it) and floats, so it never moves or blocks the page", () => {
    render(<InfoTip label="About Reports">Reports use signed visit time.</InfoTip>);
    const button = screen.getByRole("button", { name: "About Reports" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(tip().className).toContain("absolute");
    expect(tip().className).toContain("group-hover:block");        // hover
    expect(tip().className).toContain("group-focus-within:block"); // keyboard focus
    expect(button.className).toContain("[@media(pointer:coarse)]:h-11"); // 44px touch target
  });
});

describe("every help text in the application is short", () => {
  it(`no InfoTip text is longer than ${INFO_TIP_MAX_CHARS} characters`, () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".tsx") && !p.includes(".test.")) files.push(p); } };
    walk(join(__dirname, "../.."));
    const tooLong: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/<InfoTip\b[^>]*>([\s\S]*?)<\/InfoTip>/g)) {
        // a {placeholder} can show a short word; count it generously
        const text = m[1]!.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "x".repeat(20)).replace(/\s+/g, " ").trim();
        if (text.length > INFO_TIP_MAX_CHARS) tooLong.push(`${f.split("/src/")[1]}: ${text.length} characters`);
      }
    }
    expect(tooLong).toEqual([]);
  });
});

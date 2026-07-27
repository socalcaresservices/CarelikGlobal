import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BodyText, Caption, CardTitle, HelperText, MetricText, PageTitle, SectionTitle, ValidationText } from "./typography";

describe("typography primitives", () => {
  it("render their children with the named text-role class", () => {
    render(
      <>
        <PageTitle>Page</PageTitle>
        <SectionTitle>Section</SectionTitle>
        <CardTitle>Card</CardTitle>
        <MetricText>42</MetricText>
        <BodyText>Body</BodyText>
        <Caption>Caption</Caption>
        <HelperText>Helper</HelperText>
        <ValidationText>Required</ValidationText>
      </>
    );

    expect(screen.getByText("Page")).toHaveClass("text-page-title");
    expect(screen.getByText("Section")).toHaveClass("text-section-title");
    expect(screen.getByText("Card")).toHaveClass("text-card-title");
    expect(screen.getByText("42")).toHaveClass("text-metric");
    expect(screen.getByText("Body")).toHaveClass("text-body");
    expect(screen.getByText("Caption")).toHaveClass("text-caption");
    expect(screen.getByText("Helper")).toHaveClass("text-caption");
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });
});

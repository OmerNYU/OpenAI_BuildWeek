import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("App", () => {
  it("renders the scaffold sections", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "FailSpec" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bug intake" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Investigation progress" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Results" })).toBeTruthy();
  });
});

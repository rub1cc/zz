import { Input, matchesKey, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Controller } from "./controller.js";
import { accent, bold, dim, fit, oneLine, warning } from "./format.js";
import { answerError, type QuestionAnswers, type QuestionStep, type QuestionForm, type QuestionOption } from "./questions.js";

interface Choice { number: number; option?: QuestionOption }
interface QuestionRow {
  text: string;
  choice?: number;
  input?: Input;
  column?: number;
  action?: "submit" | "cancel";
}

export class QuestionComposer implements Component, Focusable {
  readonly input = new Input({ prompt: "", placeholder: "type something", placeholderStyle: dim });
  private stepIndex = 0;
  private answers: QuestionAnswers = Object.create(null) as QuestionAnswers;
  private drafts = new Map<number, string>();
  private cursors = new Map<number, number>();
  private checked = new Map<number, Set<string>>();
  private customChecked = new Set<number>();
  private editingOther = false;
  private selected = 0;
  private reviewChoice = 0;
  private offset = 0;
  private error = "";
  private rows: QuestionRow[] = [];
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.syncFocus(); }
  private get reviewMaxHeight(): number { return Math.max(3, Math.min(18, Math.floor(this.tui.terminal.rows * 0.6))); }
  private get step(): QuestionStep | undefined { return this.form.request.questions[this.stepIndex]; }
  private get isOther(): boolean { const choice = this.choices()[this.selected]; return !!choice && !choice.option; }

  constructor(readonly controller: Controller, readonly tui: TuiAltScreen,
    readonly form: QuestionForm, readonly onDismiss: () => void = () => {}) {
    this.load();
  }

  private choices(): Choice[] {
    const step = this.step;
    if (!step || step.type === "input") return [];
    const choices: Choice[] = (step.options ?? []).map((option, index) => ({ number: index + 1, option }));
    if (step.allowOther !== false) choices.push({ number: (step.options?.length ?? 0) + 1 });
    return choices;
  }

  private syncFocus(): void {
    this.input.focused = this.focused && !!this.step && (this.step.type === "input" || this.isOther);
  }

  private load(): void {
    this.input.setValue(this.drafts.get(this.stepIndex) ?? "");
    this.input.handleInput("\x05");
    this.selected = this.cursors.get(this.stepIndex) ?? 0;
    this.offset = 0; this.error = ""; this.editingOther = false;
    this.syncFocus();
  }

  private save(): void {
    this.drafts.set(this.stepIndex, this.input.getValue());
    this.cursors.set(this.stepIndex, this.selected);
    if (this.step?.type === "input") {
      const value = this.input.getValue().trim();
      if (value) this.answers[this.step.id] = value;
      else delete this.answers[this.step.id];
    }
  }

  private updateMulti(): void {
    const step = this.step!;
    const values = [...(this.checked.get(this.stepIndex) ?? [])];
    const custom = this.input.getValue().trim();
    if (custom && this.customChecked.has(this.stepIndex)) values.push(custom);
    this.answers[step.id] = [...new Set(values)];
  }

  private editAnswer(data: string): void {
    this.editingOther = true;
    this.input.handleInput(data);
    const value = this.input.getValue().trim();
    this.drafts.set(this.stepIndex, this.input.getValue());
    if (this.step!.type === "multiselect") {
      if (value) this.customChecked.add(this.stepIndex); else this.customChecked.delete(this.stepIndex);
      this.updateMulti();
    } else if (value) this.answers[this.step!.id] = value;
    else delete this.answers[this.step!.id];
  }

  private toggle(choice: Choice): void {
    if (!choice.option) {
      if (this.input.getValue().trim()) {
        if (this.customChecked.has(this.stepIndex)) this.customChecked.delete(this.stepIndex);
        else this.customChecked.add(this.stepIndex);
      }
    } else {
      const values = this.checked.get(this.stepIndex) ?? new Set<string>();
      if (values.has(choice.option.value)) values.delete(choice.option.value); else values.add(choice.option.value);
      this.checked.set(this.stepIndex, values);
    }
    this.updateMulti();
  }

  private next(skipValidation = false): void {
    if (!this.step) return;
    this.save();
    if (!skipValidation) {
      const answer = this.answers[this.step.id];
      if (this.step.type === "multiselect" && (!Array.isArray(answer) || !answer.length)) {
        this.error = "Select at least one option with Space."; return;
      }
      if (this.step.type !== "multiselect" && (typeof answer !== "string" || !answer.trim())) {
        this.error = this.step.type === "input" || this.isOther ? "Enter an answer to continue." : "Choose an option to continue."; return;
      }
    }
    this.stepIndex++;
    this.load();
  }

  private back(): void {
    this.save();
    if (this.stepIndex > 0) { this.stepIndex--; this.load(); }
  }

  private dismiss(): void {
    this.save(); this.onDismiss();
    this.controller.questionForm = undefined;
    this.controller.notice = "Question still waiting. Use /answer to reopen, or reply normally.";
    this.controller.changed();
  }

  private submit(): void {
    const error = answerError(this.form.request, this.answers);
    if (error) { this.error = error; return; }
    this.controller.answerQuestions(this.form.sessionId, this.form.request.id, this.answers);
  }

  private activate(): void {
    const step = this.step;
    if (!step) { if (this.reviewChoice === 0) this.submit(); else this.dismiss(); return; }
    if (step.type === "input") { this.next(); return; }
    const choices = this.choices();
    const choice = choices[this.selected];
    if (step.type === "multiselect") {
      if (!choice) this.next();
      else if (choice.option) this.toggle(choice);
      else this.selected = choices.length;
    } else if (choice?.option) {
      this.answers[step.id] = choice.option.value;
      this.next();
    } else if (choice) this.next();
    else this.error = "Choose an option to continue.";
  }

  private move(delta: number): void {
    const count = this.choices().length + (this.step?.type === "multiselect" ? 1 : 0);
    if (count) this.selected = (this.selected + delta + count) % count;
    this.error = ""; this.editingOther = false; this.syncFocus();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.dismiss(); return; }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "ctrl+b")) this.back();
    else if (matchesKey(data, "tab")) this.next(true);
    else if (matchesKey(data, "enter")) { this.error = ""; this.activate(); }
    else if (!this.step) {
      if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+p")) this.reviewChoice = 1 - this.reviewChoice;
      else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 3);
      else if (matchesKey(data, "pageDown")) this.offset += 3;
    } else if (this.step.type !== "input" && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+p"))) {
      this.move(matchesKey(data, "up") || matchesKey(data, "ctrl+p") ? -1 : 1);
    } else if (this.isOther && this.step.type === "multiselect" && !this.editingOther && matchesKey(data, "space")) {
      this.toggle(this.choices()[this.selected]!); this.error = "";
    } else if (this.step.type === "input" || this.isOther) {
      this.editAnswer(data); this.error = "";
    } else if (matchesKey(data, "space")) {
      const choice = this.choices()[this.selected];
      this.error = "";
      if (this.step.type === "multiselect") { if (choice) this.toggle(choice); else this.next(); }
      else if (choice?.option) this.answers[this.step.id] = choice.option.value;
    } else if (data >= " " || data.startsWith("\x1b[200~")) {
      const other = this.choices().findIndex((choice) => !choice.option);
      if (other >= 0) { this.selected = other; this.editAnswer(data); this.error = ""; }
    }
    this.syncFocus(); this.tui.requestRender();
  }

  private choiceRows(width: number): QuestionRow[] {
    const step = this.step!;
    const answer = this.answers[step.id];
    return this.choices().flatMap((choice, index) => {
      const selected = index === this.selected;
      const checked = choice.option ? Array.isArray(answer) && answer.includes(choice.option.value) : this.customChecked.has(this.stepIndex);
      const prefix = `${selected ? ">" : " "} ${choice.number}. ${step.type === "multiselect" ? checked ? "[x] " : "[ ] " : ""}`;
      const column = prefix.length;
      if (!choice.option) return [{ text: `${selected ? accent(prefix) : prefix}${this.input.render(Math.max(1, width - column))[0] ?? ""}`,
        choice: index, input: this.input, column }, ...wrapTextWithAnsi("Type your own answer.", Math.max(1, width - column))
          .map((line) => ({ text: `${" ".repeat(column)}${dim(line)}`, choice: index, input: this.input, column }))];
      const label = wrapTextWithAnsi(oneLine(choice.option.label), Math.max(1, width - column));
      const rows: QuestionRow[] = label.map((line, i) => ({ text: `${i ? " ".repeat(column) : selected ? accent(prefix) : prefix}${selected ? accent(line) : line}`, choice: index }));
      const description = oneLine(choice.option.description ?? "").trim() || "No description provided.";
      rows.push(...wrapTextWithAnsi(description, Math.max(1, width - column))
        .map((line) => ({ text: `${" ".repeat(column)}${dim(line)}`, choice: index })));
      rows.push({ text: "" });
      return rows;
    });
  }

  private reviewRows(width: number): QuestionRow[] {
    return this.form.request.questions.flatMap((question) => {
      const answer = this.answers[question.id];
      const values = Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : [];
      const text = values.length ? values.map((value) => question.options?.find((option) => option.value === value)?.label ?? value).join(", ") : "Not answered";
      return [...wrapTextWithAnsi(bold(oneLine(question.question)), width), ...wrapTextWithAnsi(accent(oneLine(text)), width), ""].map((text) => ({ text }));
    });
  }

  render(width: number, height = this.tui.terminal.rows): string[] {
    const inner = Math.max(1, width);
    this.syncFocus();
    const request = this.form.request;
    const step = this.step;
    const tabs = [...request.questions.map((question, i) => {
      const answer = this.answers[question.id];
      const label = `${Array.isArray(answer) ? answer.length ? "[x]" : "[ ]" : answer ? "[x]" : "[ ]"} ${oneLine(question.id)}`;
      return i === this.stepIndex ? accent(bold(label)) : dim(label);
    }), !step ? accent(bold("Submit")) : dim("Submit")];
    const progress = tabs.join("  ");
    const header: QuestionRow[] = [{ text: visibleWidth(progress) <= inner ? progress : `< ${tabs[this.stepIndex]} >` }, { text: dim(step ? `Question ${this.stepIndex + 1} of ${request.questions.length}` : "Review your answers / nothing sent yet") }, { text: "" }];
    if (step) {
      header.push(...wrapTextWithAnsi(bold(oneLine(step.question)), inner).slice(0, 3).map((text) => ({ text })), { text: "" });
    } else if (answerError(request, this.answers)) header.push({ text: warning("You have not answered all questions") }, { text: "" });
    const footer: QuestionRow[] = [];
    if (step?.type === "multiselect") footer.push({ text: "" }, { text: this.selected === this.choices().length ? accent("> Next") : "  Next", choice: this.choices().length });
    if (!step) footer.push({ text: dim("Ready to submit your answers?") },
      { text: this.reviewChoice === 0 ? accent("> 1. Submit answers") : "  1. Submit answers", action: "submit" },
      { text: this.reviewChoice === 1 ? accent("> 2. Cancel") : "  2. Cancel", action: "cancel" });
    const hint = !step ? "Ctrl+N/P choose / Enter send / Shift+Tab back / PgUp/Dn scroll / Esc close"
      : step.type === "multiselect" ? "Space toggle / Tab next / Shift+Tab back / Enter activate / Esc close"
      : "Enter next / Tab next / Shift+Tab back / Esc close";
    footer.push({ text: this.error || this.controller.notice ? warning(oneLine(this.error || this.controller.notice)) : dim(hint) });
    let body: QuestionRow[];
    if (step) {
      body = step.type === "input" ? [{ text: this.input.render(inner)[0] ?? "", input: this.input, column: 0 }] : this.choiceRows(inner);
      if (step.type === "input" && !this.input.getValue() && step.placeholder) body.unshift({ text: dim(oneLine(step.placeholder)) });
    } else {
      // Only the potentially long review scrolls; choice steps always show every description.
      const available = this.reviewMaxHeight - 2;
      for (let i = header.length - 1; i >= 0 && header.length + footer.length + 1 > available; i--) {
        if (!header[i]!.text) header.splice(i, 1);
      }
      while (header.length && header.length + footer.length + 1 > available) header.shift();
      const budget = Math.max(1, available - header.length - footer.length);
      const review = this.reviewRows(inner);
      this.offset = Math.min(this.offset, Math.max(0, review.length - budget));
      body = review.slice(this.offset, this.offset + budget);
    }
    const rows = [...header, ...body, ...footer];
    if (step) {
      // Reclaim spacing before sacrificing transcript space; never clip options or descriptions.
      for (let i = rows.length - 1; i >= 0 && rows.length > height - 2; i--) {
        if (rows[i]!.text === "") rows.splice(i, 1);
      }
    } else if (rows.length > this.reviewMaxHeight - 2) rows.splice(0, rows.length - (this.reviewMaxHeight - 2));
    const border = { text: dim("\u2500".repeat(Math.max(0, width))) };
    this.rows = [border, ...rows, border];
    return this.rows.map((row) => fit(row.text, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      if (this.step) return;
      this.offset = Math.max(0, this.offset + delta);
      return { handled: true, focus: false, render: true };
    }
    const row = this.rows[event.y];
    if (!row || event.button !== "left" || (event.type !== "click" && event.type !== "press")) return;
    this.error = "";
    if (row.action) {
      this.reviewChoice = row.action === "submit" ? 0 : 1;
      if (event.type === "click") this.activate();
    } else if (row.choice !== undefined) {
      this.selected = row.choice;
      this.editingOther = false;
      if (row.input) {
        if (event.type === "click" && this.step?.type === "multiselect" && event.x < (row.column ?? 0)) this.toggle(this.choices()[this.selected]!);
        else {
          this.editingOther = true;
          row.input.handleMouse({ ...event, x: Math.max(0, event.x - (row.column ?? 0)), y: 0, width: Math.max(1, event.width - (row.column ?? 0)) });
        }
      } else if (event.type === "click") this.activate();
    } else if (row.input) row.input.handleMouse({ ...event, y: 0 });
    else return;
    this.syncFocus();
    return { handled: true, focus: false, render: true };
  }

  invalidate(): void { this.input.invalidate(); }
}

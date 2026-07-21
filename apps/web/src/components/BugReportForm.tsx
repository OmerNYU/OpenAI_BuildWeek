import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { investigationRequestSchema, type InvestigationRequest } from "@failspec/contracts";

export interface BugReportFormProps {
  disabled: boolean;
  submitting?: boolean;
  submissionError?: string;
  onSubmit: (request: InvestigationRequest) => Promise<void>;
}

type FormValues = Record<keyof InvestigationRequest, string>;
type FieldErrors = Partial<Record<keyof InvestigationRequest, string>>;

const initialValues: FormValues = {
  repositoryPath: "",
  bugTitle: "",
  bugDescription: "",
  expectedBehavior: "",
  actualBehavior: "",
  terminalLog: "",
  screenshotPath: ""
};

const fields: Array<{
  name: keyof InvestigationRequest;
  label: string;
  hint?: string;
  multiline?: boolean;
  optional?: boolean;
}> = [
  { name: "repositoryPath", label: "Repository path", hint: "Absolute path to the clean local repository you want to investigate." },
  { name: "bugTitle", label: "Bug title", hint: "Use a short description of the user-visible failure." },
  { name: "bugDescription", label: "Bug description", hint: "Describe the smallest sequence that exposes the problem.", multiline: true },
  { name: "expectedBehavior", label: "Expected behavior", hint: "State the outcome the user should see.", multiline: true },
  { name: "actualBehavior", label: "Actual behavior", hint: "State the outcome the user sees instead.", multiline: true },
  { name: "terminalLog", label: "Terminal log", multiline: true, optional: true },
  { name: "screenshotPath", label: "Screenshot path", optional: true }
];

export function BugReportForm({ disabled, submitting = false, submissionError, onSubmit }: BugReportFormProps) {
  const [values, setValues] = useState<FormValues>(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const submissionErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (submissionError) {
      submissionErrorRef.current?.focus();
    }
  }, [submissionError]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = normalize(values);
    const parsed = investigationRequestSchema.safeParse(candidate);

    if (!parsed.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof InvestigationRequest;
        fieldErrors[field] ??= requiredMessage(field);
      }
      setErrors(fieldErrors);
      return;
    }

    setErrors({});
    await onSubmit(parsed.data);
  }

  return (
    <form noValidate onSubmit={submit}>
      {submissionError ? (
        <div className="form-error" role="alert" tabIndex={-1} ref={submissionErrorRef}>
          {submissionError}
        </div>
      ) : null}
      <p className="form-intro">Required fields are enough to begin. Add logs or a screenshot path only when they help explain the failure.</p>
      <div className="form-grid">{fields.filter((field) => !field.optional).map(renderField)}</div>
      <details className="optional-context">
        <summary>Add technical context (optional)</summary>
        <div className="form-grid">{fields.filter((field) => field.optional).map(renderField)}</div>
      </details>
      <button type="submit" disabled={disabled} aria-busy={submitting}>
        {submitting ? "Starting investigation…" : "Start investigation"}
      </button>
    </form>
  );

  function renderField(field: typeof fields[number]) {
    const error = errors[field.name];
    const inputId = `investigation-${field.name}`;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;
    const describedBy = [field.hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(" ") || undefined;
    const commonProps = {
      id: inputId,
      name: field.name,
      value: values[field.name],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setValues((current) => ({ ...current, [field.name]: event.target.value })),
      disabled,
      "aria-invalid": Boolean(error),
      "aria-describedby": describedBy
    };

    return (
      <div className="form-field" key={field.name}>
        <label htmlFor={inputId}>{field.label}{field.optional ? " (optional)" : ""}</label>
        {field.hint ? <p className="field-hint" id={hintId}>{field.hint}</p> : null}
        {field.multiline ? <textarea rows={4} {...commonProps} /> : <input {...commonProps} />}
        {error ? <p className="field-error" id={errorId}>{error}</p> : null}
      </div>
    );
  }
}

function normalize(values: FormValues): InvestigationRequest {
  return {
    repositoryPath: values.repositoryPath.trim(),
    bugTitle: values.bugTitle.trim(),
    bugDescription: values.bugDescription.trim(),
    expectedBehavior: values.expectedBehavior.trim(),
    actualBehavior: values.actualBehavior.trim(),
    ...(values.terminalLog.trim() ? { terminalLog: values.terminalLog.trim() } : {}),
    ...(values.screenshotPath.trim() ? { screenshotPath: values.screenshotPath.trim() } : {})
  };
}

function requiredMessage(field: keyof InvestigationRequest): string {
  return `Enter ${fields.find((candidate) => candidate.name === field)?.label.toLowerCase() ?? "a value"}.`;
}

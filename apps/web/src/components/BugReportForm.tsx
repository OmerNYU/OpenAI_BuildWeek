import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { investigationRequestSchema, type InvestigationRequest } from "@failspec/contracts";

export interface BugReportFormProps {
  disabled: boolean;
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
  multiline?: boolean;
  optional?: boolean;
}> = [
  { name: "repositoryPath", label: "Repository path" },
  { name: "bugTitle", label: "Bug title" },
  { name: "bugDescription", label: "Bug description", multiline: true },
  { name: "expectedBehavior", label: "Expected behavior", multiline: true },
  { name: "actualBehavior", label: "Actual behavior", multiline: true },
  { name: "terminalLog", label: "Terminal log", multiline: true, optional: true },
  { name: "screenshotPath", label: "Screenshot path", optional: true }
];

export function BugReportForm({ disabled, submissionError, onSubmit }: BugReportFormProps) {
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
        fieldErrors[field] ??= issue.message;
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
      <div className="form-grid">
        {fields.map((field) => {
          const error = errors[field.name];
          const inputId = `investigation-${field.name}`;
          const errorId = `${inputId}-error`;
          const commonProps = {
            id: inputId,
            name: field.name,
            value: values[field.name],
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setValues((current) => ({ ...current, [field.name]: event.target.value })),
            disabled,
            "aria-invalid": Boolean(error),
            "aria-describedby": error ? errorId : undefined
          };

          return (
            <div className="form-field" key={field.name}>
              <label htmlFor={inputId}>
                {field.label}{field.optional ? " (optional)" : ""}
              </label>
              {field.multiline ? <textarea rows={4} {...commonProps} /> : <input {...commonProps} />}
              {error ? <p className="field-error" id={errorId}>{error}</p> : null}
            </div>
          );
        })}
      </div>
      <button type="submit" disabled={disabled}>Start investigation</button>
    </form>
  );
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

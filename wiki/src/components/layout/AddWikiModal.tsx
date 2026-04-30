"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { T } from "@/lib/typography";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { Toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { WikiSettingsPrefill } from "@/lib/wikiSettingsPrefill";
import {
  useWikiTypesList,
  findWikiType,
  type WikiTypeListItem,
} from "@/hooks/useWikiTypesList";
import { useToggleBouncerMode } from "@/hooks/useToggleBouncerMode";
import { publishWiki, unpublishWiki, updateWiki } from "@/lib/generated";

export type { WikiSettingsPrefill } from "@/lib/wikiSettingsPrefill";

export interface AddWikiModalProps {
  open: boolean;
  onClose: () => void;
  /** Figma 311:5034 — defaults to Create New Wiki */
  title?: string;
  confirmLabel?: string;
  /** When opening from an existing wiki (gear), seed form fields */
  prefill?: WikiSettingsPrefill | null;
  /** Wiki id for settings-mode PUT. 'preview' or undefined → skip network call (prototype pages). */
  wikiId?: string;
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className={className}
    >
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1" />
      <path
        d="M7 5.5v3.5M7 4v.25"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Label
      className="text-[12px] font-normal leading-4 tracking-[0.32px]"
      style={{ color: "#545353" }}
    >
      {children}
    </Label>
  );
}


export default function AddWikiModal({
  open,
  onClose,
  title = "Create New Wiki",
  confirmLabel = "Create Wiki",
  prefill = null,
  wikiId,
}: AddWikiModalProps) {
  const wasOpen = useRef(false);
  const [name, setName] = useState("");
  const [wikiType, setWikiType] = useState("");
  const [description, setDescription] = useState("");
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  /** Wiki prompt state (emulated local state; will move to OS.robin store later) */
  const [wikiPrompt, setWikiPrompt] = useState<string>("");
  const [wikiPromptEdited, setWikiPromptEdited] = useState<boolean>(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState<string>("");
  /** Existing-wiki settings: form read-only until user clicks Edit Wiki */
  const [fieldsEditable, setFieldsEditable] = useState(true);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("Saved");
  const saveCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevWikiTypeRef = useRef<string>("");
  const [bouncerMode, setBouncerMode] = useState<"auto" | "review">("auto");
  const initialBouncerModeRef = useRef<"auto" | "review">("auto");
  /** #255: publish toggle state inside settings modal. */
  const [published, setPublished] = useState<boolean>(false);
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const isSettingsView = Boolean(prefill);

  const queryClient = useQueryClient();
  const toggleBouncer = useToggleBouncerMode();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: wikiTypesData, isLoading: typesLoading } = useWikiTypesList();

  // API returns YAML-backed types only; `people` has no YAML on disk.
  const sortedTypes = useMemo<WikiTypeListItem[]>(() => {
    const apiList = wikiTypesData?.wikiTypes ?? [];
    return [...apiList]
      .filter((t) => t.slug !== "people")
      .sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
  }, [wikiTypesData?.wikiTypes]);

  useEffect(() => {
    if (open) {
      if (!wasOpen.current) {
        setShowSavedToast(false);
        setSubmitError(null);
        setSubmitting(false);
        if (saveCloseTimerRef.current) {
          clearTimeout(saveCloseTimerRef.current);
          saveCloseTimerRef.current = null;
        }
        if (prefill) {
          const nextType = prefill.wikiType ?? "";
          setName(prefill.name ?? "");
          setWikiType(nextType);
          setDescription(prefill.description ?? "");
          setSubtitle(prefill.subtitle);
          setWikiPrompt(prefill.promptOverride ?? "");
          setWikiPromptEdited(
            Boolean(
              prefill.promptOverride && prefill.promptOverride.length > 0,
            ),
          );
          prevWikiTypeRef.current = nextType;
          const bm = prefill.bouncerMode ?? "auto";
          setBouncerMode(bm);
          initialBouncerModeRef.current = bm;
          setPublished(Boolean(prefill.published));
          setPublishedSlug(prefill.publishedSlug ?? null);
          setPublishError(null);
          setFieldsEditable(false);
        } else {
          setName("");
          setWikiType("");
          setDescription("");
          setSubtitle(undefined);
          setWikiPrompt("");
          setWikiPromptEdited(false);
          prevWikiTypeRef.current = "";
          setBouncerMode("auto");
          initialBouncerModeRef.current = "auto";
          setPublished(false);
          setPublishedSlug(null);
          setPublishError(null);
          setFieldsEditable(true);
        }
        setPromptDialogOpen(false);
      }
      wasOpen.current = true;
    } else {
      wasOpen.current = false;
    }
  }, [open, prefill]);

  useEffect(() => {
    return () => {
      if (saveCloseTimerRef.current) {
        clearTimeout(saveCloseTimerRef.current);
        saveCloseTimerRef.current = null;
      }
    };
  }, []);

  /**
   * Prompt customization is tied to a specific wiki type. When the type
   * changes, discard any override and reload the new type's default — a
   * "Customized Voice Prompt" wouldn't make sense if the user originally
   * customized the Agent prompt.
   */
  useEffect(() => {
    if (prevWikiTypeRef.current === wikiType) return;
    prevWikiTypeRef.current = wikiType;
    setWikiPromptEdited(false);
    setWikiPrompt("");
  }, [wikiType]);

  const locked = isSettingsView && !fieldsEditable;

  const handleConfirm = async () => {
    if (locked) {
      setFieldsEditable(true);
      return;
    }
    if (isSettingsView) {
      const trimmedName = name.trim();
      if (trimmedName.length < 3) {
        setSubmitError("Name must be at least 3 characters.");
        return;
      }
      if (!wikiType) {
        setSubmitError("Pick a wiki type.");
        return;
      }

      // Prototype-page sentinel: skip network call, preserve UX.
      const isSentinel = !wikiId || wikiId === "preview";
      if (isSentinel) {
        if (saveCloseTimerRef.current) {
          clearTimeout(saveCloseTimerRef.current);
          saveCloseTimerRef.current = null;
        }
        onClose();
        setToastMessage("Saved");
        setShowSavedToast(true);
        saveCloseTimerRef.current = setTimeout(() => {
          setShowSavedToast(false);
          saveCloseTimerRef.current = null;
        }, 2000);
        return;
      }

      setSubmitting(true);
      setSubmitError(null);
      try {
        // Empty string clears the override; non-empty sets it.
        // Never send null — Zod rejects.
        const payload: { name?: string; type?: string; description?: string; prompt: string } = {
          prompt: wikiPrompt,
        };
        if (prefill && trimmedName !== prefill.name) {
          payload.name = trimmedName;
        }
        if (prefill && wikiType !== prefill.wikiType) {
          payload.type = wikiType;
        }
        if (prefill && description !== prefill.description) {
          payload.description = description;
        }
        const { error } = await updateWiki({
          path: { id: wikiId },
          body: payload,
          credentials: "include",
        });
        if (error) {
          const message =
            (error as { error?: string })?.error ?? "Save failed.";
          setSubmitError(message);
          return;
        }
        // Toggle bouncer mode separately if changed
        if (bouncerMode !== initialBouncerModeRef.current) {
          try {
            await toggleBouncer.mutateAsync({ id: wikiId, mode: bouncerMode });
          } catch {
            // Non-fatal
          }
        }
        await queryClient.invalidateQueries({ queryKey: ["wikis"] });
        await queryClient.invalidateQueries({ queryKey: ["wiki", wikiId] });
        onClose();
        setToastMessage("Saved");
        setShowSavedToast(true);
        if (saveCloseTimerRef.current) {
          clearTimeout(saveCloseTimerRef.current);
        }
        saveCloseTimerRef.current = setTimeout(() => {
          setShowSavedToast(false);
          saveCloseTimerRef.current = null;
        }, 2000);
      } catch {
        setSubmitError("Network error. Check your connection and retry.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Create mode — hit POST /api/wikis.
    const trimmedName = name.trim();
    if (trimmedName.length < 3) {
      setSubmitError("Name must be at least 3 characters.");
      return;
    }
    if (!wikiType) {
      setSubmitError("Pick a wiki type.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmedPrompt = wikiPrompt.trim();
      const body = {
        name: trimmedName,
        type: wikiType,
        description: description.trim() || undefined,
        prompt: trimmedPrompt.length > 0 ? trimmedPrompt : undefined,
      };
      const res = await fetch("/api/wikis", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Create failed (${res.status})`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch {
          /* ignore JSON parse */
        }
        setSubmitError(message);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
      onClose();
      setToastMessage("Wiki created");
      setShowSavedToast(true);
      if (saveCloseTimerRef.current) {
        clearTimeout(saveCloseTimerRef.current);
      }
      saveCloseTimerRef.current = setTimeout(() => {
        setShowSavedToast(false);
        saveCloseTimerRef.current = null;
      }, 2000);
    } catch {
      setSubmitError("Network error. Check your connection and retry.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent
          className="p-0 sm:max-w-[571px] gap-0 rounded-2xl border-black/10 flex flex-col"
          style={{ maxHeight: "min(631px, 90vh)", overflow: "hidden" }}
        >
          <DialogHeader className="px-5 pt-5 pb-2 shrink-0">
            <DialogTitle
              style={{
                ...T.h1,
                color: "#111111",
                fontWeight: 400,
                margin: 0,
              }}
            >
              {title}
            </DialogTitle>
            <DialogDescription
              style={{
                ...T.micro,
                lineHeight: "19px",
                color: "#676d76",
                margin: 0,
              }}
            >
              {subtitle ?? "Create a new wiki to organize your knowledge."}
            </DialogDescription>
          </DialogHeader>

          <div className="h-px w-full bg-[#e5e5e5] shrink-0" />

          {/* Scrollable body */}
          <div className="flex-1 min-h-0 overflow-y-auto">

          {/* Name */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>Name</FieldLabel>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="E.g The City of Trust"
              disabled={locked}
              className="h-10"
            />
          </div>

          {/* Type */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>
              Type <InfoIcon className="text-[#545353]" />
            </FieldLabel>
            <div className="relative">
              <select
                value={wikiType}
                onChange={(e) => setWikiType(e.target.value)}
                disabled={locked}
                aria-label="Wiki type"
                className="flex h-10 w-full items-center rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none appearance-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                style={{ color: wikiType ? "#111111" : "#a8a8a8" }}
              >
                <option value="">
                  {typesLoading ? "Loading types…" : "Choose a type"}
                </option>
                {sortedTypes.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.displayLabel}
                  </option>
                ))}
              </select>
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#a8a8a8]"
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          {/* Description */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>
              Description <InfoIcon className="text-[#545353]" />
            </FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Countries I have visited. Whether a specific county meets the threshold."
              rows={3}
              disabled={locked}
              className="min-h-[96px] resize-none"
            />
          </div>

          {/* Wiki Prompt */}
          <div className="px-5 pt-4 flex flex-col gap-2">
            <FieldLabel>
              Wiki Prompt <InfoIcon className="text-[#545353]" />
            </FieldLabel>
            {(() => {
              const hasType = Boolean(wikiType);
              const typeLabel =
                findWikiType(wikiTypesData, wikiType)?.displayLabel ??
                (wikiType
                  ? wikiType.charAt(0).toUpperCase() + wikiType.slice(1)
                  : "");
              const disabled = locked || !hasType;
              const badgeText = !hasType
                ? "Pick a type to customize"
                : wikiPromptEdited
                  ? `Customized ${typeLabel} Prompt`
                  : `Default ${typeLabel} Prompt`;
              const badgeColors = wikiPromptEdited
                ? { fg: "var(--wiki-link)", bg: "rgba(51, 102, 204, 0.10)", bd: "var(--wiki-link)" }
                : { fg: "var(--input-label)", bg: "var(--surface-subtle)", bd: "var(--btn-disabled-bg)" };
              return (
                <div
                  className="flex h-10 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5"
                  style={{ opacity: disabled ? 0.6 : 1 }}
                >
                  <span
                    className="inline-flex items-center"
                    style={{
                      ...T.micro,
                      padding: "2px 8px",
                      color: badgeColors.fg,
                      background: badgeColors.bg,
                      border: `1px solid ${badgeColors.bd}`,
                    }}
                  >
                    {badgeText}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (disabled) return;
                      setPromptDraft(wikiPrompt);
                      setPromptDialogOpen(true);
                    }}
                    disabled={disabled}
                    aria-label="Edit wiki prompt"
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#545353] transition-colors hover:bg-[#f5f5f5] disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <Pencil size={14} strokeWidth={1.5} aria-hidden />
                  </button>
                </div>
              );
            })()}
          </div>

          {/* Fragment Review Mode toggle -- settings mode only */}
          {isSettingsView && (
            <div className="px-5 pt-4 flex items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <FieldLabel>Fragment Review Mode</FieldLabel>
                <span className="text-[11px] leading-4" style={{ color: "#676d76" }}>
                  {bouncerMode === "review"
                    ? "New fragments require manual approval"
                    : "Fragments auto-accepted into this wiki"}
                </span>
              </div>
              <Switch
                checked={bouncerMode === "review"}
                onCheckedChange={(checked: boolean) =>
                  setBouncerMode(checked ? "review" : "auto")
                }
                disabled={locked}
                size="sm"
              />
            </div>
          )}

          {/* #255: Publish/unpublish toggle — settings mode only.
              Calls the existing /wikis/:id/publish + /unpublish endpoints
              eagerly (no save-button gating) so the toggle reflects the
              live published state at all times. */}
          {isSettingsView && wikiId && wikiId !== "preview" && (
            <div className="px-5 pt-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <FieldLabel>Publish</FieldLabel>
                  <span className="text-[11px] leading-4" style={{ color: "#676d76" }}>
                    {published
                      ? "Public — anyone with the link can read this wiki"
                      : "Private — only you can read this wiki"}
                  </span>
                </div>
                <Switch
                  aria-label="Publish wiki"
                  checked={published}
                  onCheckedChange={async (next: boolean) => {
                    if (publishBusy) return;
                    setPublishBusy(true);
                    setPublishError(null);
                    try {
                      if (next) {
                        const { data, error } = await publishWiki({
                          path: { id: wikiId },
                          credentials: "include",
                        });
                        if (error) throw new Error((error as { error?: string })?.error ?? "Publish failed");
                        setPublished(true);
                        setPublishedSlug(
                          (data as { publishedSlug?: string } | undefined)?.publishedSlug ?? null,
                        );
                      } else {
                        const { error } = await unpublishWiki({
                          path: { id: wikiId },
                          credentials: "include",
                        });
                        if (error) throw new Error((error as { error?: string })?.error ?? "Unpublish failed");
                        setPublished(false);
                      }
                      await queryClient.invalidateQueries({ queryKey: ["wikis"] });
                      await queryClient.invalidateQueries({ queryKey: ["wiki", wikiId] });
                    } catch (err) {
                      setPublishError(err instanceof Error ? err.message : "Toggle failed");
                    } finally {
                      setPublishBusy(false);
                    }
                  }}
                  disabled={publishBusy}
                  size="sm"
                />
              </div>
              {published && publishedSlug ? (
                <div
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
                  style={{ background: "var(--surface-subtle)", border: "1px solid var(--btn-disabled-bg)" }}
                >
                  <span
                    style={{ ...T.micro, color: "var(--input-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {`/p/${publishedSlug}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const url = `${window.location.origin}/p/${publishedSlug}`;
                      void navigator.clipboard.writeText(url).catch(() => {});
                    }}
                    className="rounded px-2 text-[11px]"
                    style={{ background: "transparent", border: "1px solid var(--btn-disabled-bg)", color: "var(--wiki-link)" }}
                  >
                    Copy link
                  </button>
                </div>
              ) : null}
              {publishError ? (
                <span style={{ ...T.micro, color: "var(--destructive)" }}>{publishError}</span>
              ) : null}
            </div>
          )}

          <div className="pb-5" />

          {submitError ? (
            <div
              role="alert"
              className="px-5 pt-3 text-[13px]"
              style={{ color: "#c0392b" }}
            >
              {submitError}
            </div>
          ) : null}

          </div>
          {/* /Scrollable body */}

          <div className="h-px w-full bg-[#e5e5e5] shrink-0" />

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-5 py-4 shrink-0">
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className="rounded-none bg-[var(--wiki-link)] text-white hover:bg-[var(--wiki-link-hover)]"
            >
              {locked
                ? confirmLabel
                : isSettingsView
                  ? submitting
                    ? "Saving…"
                    : "Save"
                  : submitting
                    ? "Creating…"
                    : confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Wiki prompt edit dialog */}
      <Dialog
        open={promptDialogOpen}
        onOpenChange={(next) => {
          if (!next) setPromptDialogOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-[480px] gap-4 rounded-xl">
          {(() => {
            const typeLabel =
              findWikiType(wikiTypesData, wikiType)?.displayLabel ?? "";
            const typeLabelLower = typeLabel.toLowerCase();
            return (
              <>
                <DialogHeader>
                  <DialogTitle
                    style={{
                      ...T.bodySmall,
                      fontWeight: 600,
                      color: "var(--heading-color)",
                    }}
                  >
                    {typeLabel} Prompt
                  </DialogTitle>
                  <DialogDescription>
                    {`Optional extra instructions. Appended to the ${typeLabelLower} type's system message at regen time. Leave empty to use the default alone.`}
                  </DialogDescription>
                </DialogHeader>

                <Textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  className="min-h-[240px] resize-none"
                  rows={12}
                  placeholder={`Extra guidance appended to the ${typeLabel} default. Leave blank for the default alone.`}
                />

                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPromptDraft("")}
                    className="rounded-none"
                  >
                    Clear
                  </Button>
                  <ActionButton
                    type="button"
                    onClick={() => {
                      setWikiPrompt(promptDraft);
                      setWikiPromptEdited(promptDraft.trim().length > 0);
                      setPromptDialogOpen(false);
                    }}
                  >
                    Save
                  </ActionButton>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Toast
        message={toastMessage}
        visible={!open && showSavedToast}
        onDismiss={() => setShowSavedToast(false)}
      />
    </>
  );
}

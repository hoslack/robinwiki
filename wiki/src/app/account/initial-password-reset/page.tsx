"use client";

import { useState } from "react";
import { type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { AuthGuard } from "@/components/AuthGuard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { T, FONT } from "@/lib/typography";

const sectionLabel: CSSProperties = {
  ...T.micro,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--wiki-count)",
  margin: 0,
};

const bodySmallText: CSSProperties = {
  ...T.micro,
  color: "var(--heading-secondary)",
  margin: 0,
};

const titleText: CSSProperties = {
  ...T.body,
  fontWeight: 500,
  color: "var(--heading-color)",
  margin: 0,
};

// Mirrors the change-password section on /profile (page.tsx:599-691) so the
// flow looks like the rest of the app even though it sits at its own route.
//
// Why a current-password field exists here even though the user "just signed
// in": better-auth's /change-password requires currentPassword, and we don't
// store the seeded password client-side. Asking again is a one-keystroke ask
// and keeps the flow on the standard auth API.
export default function InitialPasswordResetPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPw !== confirmPw) return;
    if (newPw.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const { error: changeError } = await authClient.changePassword({
        currentPassword: currentPw,
        newPassword: newPw,
      });
      if (changeError) {
        setError(changeError.message ?? "Could not change password.");
        return;
      }

      const res = await fetch("/api/users/clear-reset-flag", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setError("Password changed but the reset flag could not be cleared. Refresh and try again.");
        return;
      }

      // Drop the cached profile + session so the AuthGuard re-reads the
      // cleared flag instead of bouncing this page again.
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      await authClient.getSession({ query: { disableCookieCache: true } });
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabled =
    submitting || !currentPw || !newPw || !confirmPw || newPw !== confirmPw;

  return (
    <AuthGuard>
      <div
        className="min-h-screen overflow-y-auto"
        style={{ background: "var(--background)", color: "var(--foreground)" }}
      >
        <div className="mx-auto max-w-[560px] px-10 pt-16 pb-20">
          <h1 style={{ ...T.h1, fontFamily: FONT.SERIF, color: "var(--heading-color)", margin: 0 }}>
            Set your password
          </h1>
          <p style={{ ...T.bodySmall, color: "var(--heading-secondary)", marginTop: 4 }}>
            Robin provisioned your account with a one-time password. Choose your own
            before continuing.
          </p>

          <section className="mt-8" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={sectionLabel}>Security</p>
            <Card size="sm" className="rounded-none">
              <CardContent className="space-y-4">
                <div>
                  <p style={titleText}>Change password</p>
                  <p style={{ ...bodySmallText, marginTop: 2 }}>
                    Pick something you&apos;ll remember — 12+ characters with letters and digits.
                  </p>
                </div>
                <form className="space-y-3" onSubmit={handleSubmit}>
                  <div className="space-y-1">
                    <Label
                      htmlFor="current-password"
                      style={{ ...T.micro, color: "var(--heading-secondary)" }}
                    >
                      Current password
                    </Label>
                    <Input
                      id="current-password"
                      type="password"
                      autoComplete="current-password"
                      value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor="new-password"
                      style={{ ...T.micro, color: "var(--heading-secondary)" }}
                    >
                      New password
                    </Label>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor="confirm-password"
                      style={{ ...T.micro, color: "var(--heading-secondary)" }}
                    >
                      Confirm new password
                    </Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPw}
                      onChange={(e) => setConfirmPw(e.target.value)}
                    />
                  </div>
                  {newPw.length > 0 && confirmPw.length > 0 && newPw !== confirmPw && (
                    <p style={{ ...T.micro, color: "var(--destructive)", margin: 0 }}>
                      Passwords do not match.
                    </p>
                  )}
                  {error && (
                    <p style={{ ...T.micro, color: "var(--destructive)", margin: 0 }}>
                      {error}
                    </p>
                  )}
                  <Button type="submit" size="sm" disabled={submitDisabled}>
                    <span style={T.buttonSmall}>
                      {submitting ? "Saving..." : "Save and continue"}
                    </span>
                  </Button>
                </form>
              </CardContent>
            </Card>
          </section>
        </div>
      </div>
    </AuthGuard>
  );
}

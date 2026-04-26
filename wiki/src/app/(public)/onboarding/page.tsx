"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/hooks/useSession";
import { Spinner } from "@/components/ui/spinner";

import OnboardingWizard from "@/components/onboarding/OnboardingWizard";

// Dedicated /onboarding surface so the wizard is deep-linkable independent of
// the gated home route at `/`. Authenticated users always see the wizard here
// (no redirect-on-onboarded), so they can revisit/replay onboarding.
// Unauthenticated users get bounced to /login.
export default function OnboardingPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading: sessionLoading } = useSession();

  useEffect(() => {
    if (!sessionLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [sessionLoading, isAuthenticated, router]);

  if (sessionLoading) {
    return (
      <div
        className="flex h-full min-h-screen w-full items-center justify-center"
        style={{ backgroundColor: "var(--color-background)" }}
      >
        <Spinner className="size-6" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <OnboardingWizard />;
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useSession } from "@/hooks/useSession";
import { useProfile } from "@/hooks/useProfile";
import { Spinner } from "@/components/ui/spinner";

import OnboardingWizard from "@/components/onboarding/OnboardingWizard";

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading: sessionLoading } = useSession();
  const { data: profile, isLoading: profileLoading } = useProfile({
    enabled: isAuthenticated,
  });

  // Redirect: not authenticated -> /login
  useEffect(() => {
    if (!sessionLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [sessionLoading, isAuthenticated, router]);

  // Redirect: authenticated + onboarded -> /wiki
  useEffect(() => {
    if (!sessionLoading && isAuthenticated && !profileLoading && profile?.onboardedAt) {
      router.replace("/wiki");
    }
  }, [sessionLoading, isAuthenticated, profileLoading, profile, router]);

  // Loading: session or profile still resolving
  if (sessionLoading || (isAuthenticated && profileLoading)) {
    return (
      <div
        className="flex h-full min-h-screen w-full items-center justify-center"
        style={{ backgroundColor: "var(--color-background)" }}
      >
        <Spinner className="size-6" />
      </div>
    );
  }

  // Not authenticated — redirect is firing, render nothing
  if (!isAuthenticated) {
    return null;
  }

  // Authenticated + already onboarded — redirect is firing, render nothing
  if (profile?.onboardedAt) {
    return null;
  }

  // Authenticated + not onboarded — show setup wizard
  return <OnboardingWizard />;
}

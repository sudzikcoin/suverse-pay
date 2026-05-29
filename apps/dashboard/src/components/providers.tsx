"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "next-auth/react";
import { useState } from "react";

/**
 * Wraps the app in NextAuth SessionProvider + TanStack Query
 * QueryClient. Lives in its own client-only file because the root
 * layout is a server component.
 */
export function Providers({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            // The panels each set their own refetchInterval. Keep the
            // background-refresh-on-window-focus enabled for fresh
            // data the moment the user comes back to the tab.
            refetchOnWindowFocus: "always",
          },
        },
      }),
  );
  return (
    <SessionProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </SessionProvider>
  );
}

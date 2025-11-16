"use client";

import { useEffect, useState } from "react";
import type { User } from "../types/chat";

export function useAuth(initialUser: User = null) {
  const [user, setUser] = useState<User>(initialUser);

  useEffect(() => {
    let active = true;
    if (initialUser) return;

    fetch("/api/auth/me")
      .then((r) => r.json().catch(() => ({ user: null })))
      .then((data) => {
        if (active) setUser(data.user ?? null);
      })
      .catch(() => {
        if (active) setUser(null);
      });

    return () => {
      active = false;
    };
  }, [initialUser]);

  return { user };
}
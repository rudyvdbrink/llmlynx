"use client";

import { useEffect, useState } from "react";
import type { User } from "../types/chat";

export function useAuth() {
  const [user, setUser] = useState<User>(null);

  useEffect(() => {
    let active = true;
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
  }, []);

  return { user };
}
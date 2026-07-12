import { createContext } from "react";
import type { LoginResponse } from "../api/client";

export interface AuthState {
  user: LoginResponse["user"] | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResponse["user"]>;
  logout: () => void;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

// LoginRoute — operator session via POST /admin/operator/session; restores
// the intended route after success (OBL-28).

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { api, ApiError, setSessionToken } from "@shared/api-client";
import { INTENDED_ROUTE_KEY } from "@shared/constants";
import { InlineError } from "@shared/components";

interface LoginForm {
  username: string;
  password: string;
}

export function LoginRoute() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ defaultValues: { username: "operator", password: "" } });

  async function onSubmit(values: LoginForm) {
    setServerError(null);
    try {
      const res = await api<{ session_token: string }>("/admin/operator/session", {
        body: values,
        token: null,
      });
      setSessionToken(res.session_token);
      let dest = "/jobs";
      try {
        const intended = sessionStorage.getItem(INTENDED_ROUTE_KEY);
        if (intended) {
          dest = intended;
          sessionStorage.removeItem(INTENDED_ROUTE_KEY);
        }
      } catch {
        /* ignore */
      }
      navigate(dest, { replace: true });
    } catch (err) {
      setServerError(
        err instanceof ApiError ? err.message : "Sign-in failed — check the connection.",
      );
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="page-enter w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <img src="/static/restoration/app/brand-mark.svg" alt="" className="h-8 w-8" />
          <div>
            <h1 className="text-xl font-semibold">Restoration Copilot</h1>
            <p className="text-sm text-muted">Operator sign-in</p>
          </div>
        </div>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="card flex flex-col gap-4 p-6"
          noValidate
        >
          <div>
            <label htmlFor="username" className="label">
              Username
            </label>
            <input
              id="username"
              className="input"
              autoComplete="username"
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? "username-error" : undefined}
              {...register("username", { required: "Username is required" })}
            />
            {errors.username && (
              <p id="username-error" className="field-error">
                {errors.username.message}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="password" className="label">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password", { required: "Password is required" })}
            />
            {errors.password && (
              <p id="password-error" className="field-error">
                {errors.password.message}
              </p>
            )}
          </div>
          {serverError && <InlineError message={serverError} />}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting}
            aria-label={isSubmitting ? "Signing in" : "Sign in"}
          >
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

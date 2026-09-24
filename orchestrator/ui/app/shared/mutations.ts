// Mutation wrappers (spec §4.6 / D12): audit-weighted mutations are
// server-authoritative (never optimistic, retry 0, onMutate stripped);
// non-audit CRUD is optimistic with rollback context.

import {
  useMutation,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { ApiError } from "./api-client";
import { TENANT_ID } from "./constants";

type AuditOptions<TData, TVariables> = Omit<
  UseMutationOptions<TData, ApiError, TVariables>,
  "onMutate"
> & { invalidateKeys?: readonly (readonly unknown[])[] };

export function useAuditMutation<TData, TVariables>(
  options: AuditOptions<TData, TVariables>,
): UseMutationResult<TData, ApiError, TVariables> {
  const qc = useQueryClient();
  const { invalidateKeys, onSettled, ...rest } = options;
  // D12: optimistic onMutate is forcibly stripped on audit paths, even if a
  // caller smuggles one past the type system.
  delete (rest as Record<string, unknown>).onMutate;
  return useMutation<TData, ApiError, TVariables>({
    ...rest,
    retry: 0,
    onSettled: (data, error, variables, onMutateResult, context) => {
      for (const key of invalidateKeys ?? []) void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: [TENANT_ID, "projects"] });
      onSettled?.(data, error, variables, onMutateResult, context);
    },
  });
}

interface CrudOptions<TData, TVariables, TContext> extends UseMutationOptions<
  TData,
  ApiError,
  TVariables,
  TContext
> {
  invalidateKeys?: readonly (readonly unknown[])[];
}

export function useCrudMutation<TData, TVariables, TContext = unknown>(
  options: CrudOptions<TData, TVariables, TContext>,
): UseMutationResult<TData, ApiError, TVariables, TContext> {
  const qc = useQueryClient();
  const { invalidateKeys, onSettled, ...rest } = options;
  return useMutation<TData, ApiError, TVariables, TContext>({
    ...rest,
    retry: 0,
    onSettled: (data, error, variables, onMutateResult, context) => {
      for (const key of invalidateKeys ?? []) void qc.invalidateQueries({ queryKey: key });
      onSettled?.(data, error, variables, onMutateResult, context);
    },
  });
}

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { handleAsaasCheckoutRequest } from "./handler.ts";

serve(async (req: Request) => {
  return handleAsaasCheckoutRequest(req, {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    asaasApiKey: Deno.env.get("ASAAS_API_KEY") ?? "",
    asaasBaseUrl: Deno.env.get("ASAAS_BASE_URL") ?? Deno.env.get("ASAAS_API_BASE_URL") ?? "",
    billingIssuancePaused: Deno.env.get("BILLING_ISSUANCE_PAUSED") === "true",
    createSupabaseClient: (url, key, options) => createClient(url, key, options),
    fetchFn: fetch,
  });
});

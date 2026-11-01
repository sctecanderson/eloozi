import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { handleAsaasWebhookRequest } from "./handler.ts";

serve(async (req: Request) => {
  return handleAsaasWebhookRequest(req, {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    supabaseServiceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    asaasWebhookToken: Deno.env.get("ASAAS_WEBHOOK_TOKEN") ?? "",
    asaasApiKey: Deno.env.get("ASAAS_API_KEY") ?? "",
    asaasBaseUrl: Deno.env.get("ASAAS_BASE_URL") ?? Deno.env.get("ASAAS_API_BASE_URL") ?? "",
    createSupabaseClient: (url, key) => createClient(url, key),
    fetchFn: fetch,
  });
});

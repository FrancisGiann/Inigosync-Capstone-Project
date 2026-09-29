const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  vary: "Origin",
};

export function jsonCorsResponse(
  body: unknown,
  status = 200,
  _origin = "",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

export function phoneValidationPreflight(): Response {
  return new Response("ok", {
    headers: { ...corsHeaders, "access-control-max-age": "86400" },
  });
}

export function phoneValidationUnavailable(retryAfterSeconds?: number): Response {
  return jsonCorsResponse(
    { message: "Phone validation is temporarily unavailable. Try again later." },
    503,
    "",
    retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {},
  );
}

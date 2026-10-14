import { jsonCorsResponse, phoneValidationPreflight } from "../validate-contact-phone/_shared/http.ts";

// This deployed endpoint used to call a paid provider and issue one-use
// validation proofs. Keep the route as a safe retirement stub so stale browser
// clients stop without spending quota or recording a proof.
Deno.serve((req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return phoneValidationPreflight();
  return jsonCorsResponse(
    { message: "Guest mobile validation has changed. Reload the staff dashboard." },
    410,
    origin,
  );
});

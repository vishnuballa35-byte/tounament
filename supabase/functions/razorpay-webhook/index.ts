import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  fetch: async (req: Request) => {
    try {
      const raw = await req.text();
      const signature = req.headers.get("x-razorpay-signature") || "";
      const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

      if (!secret) return new Response("Not configured", { status: 500 });

      const expected = await hmacHex(secret, raw);
      if (expected !== signature) {
        return new Response("Invalid signature", { status: 400 });
      }

      const event = JSON.parse(raw);

      if (event.event === "payment.captured" || event.event === "order.paid") {
        const payment = event.payload?.payment?.entity;
        const orderId =
          payment?.order_id || event.payload?.order?.entity?.id;

        if (orderId) {
          const db = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
          );

          const { data: row } = await db
            .from("tournament_payments")
            .select("id,registration_id")
            .eq("razorpay_order_id", orderId)
            .maybeSingle();

          if (row) {
            await db
              .from("tournament_payments")
              .update({
                payment_status: "PAID",
                razorpay_payment_id: payment?.id ?? null,
              })
              .eq("id", row.id);

            await db
              .from("tournament_registrations")
              .update({ registration_status: "APPROVED" })
              .eq("id", row.registration_id);
          }
        }
      }

      return new Response("ok");
    } catch (error) {
      console.error("webhook error:", error);
      return new Response("error", { status: 500 });
    }
  },
};
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

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
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    try {
      if (req.method !== "POST") {
        return Response.json({ error: "Only POST allowed." }, { status: 405 });
      }

      const playerId =
        (ctx.userClaims as any)?.id ?? (ctx.userClaims as any)?.sub;

      if (!playerId) {
        return Response.json({ error: "Please log in again." }, { status: 401 });
      }

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = await req.json();

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return Response.json(
          { error: "Missing payment details." },
          { status: 400 }
        );
      }

      const secret = Deno.env.get("RAZORPAY_KEY_SECRET");
      if (!secret) {
        return Response.json(
          { error: "Payment service is not configured." },
          { status: 500 }
        );
      }

      // 1. Check Razorpay's signature
      const expected = await hmacHex(
        secret,
        `${razorpay_order_id}|${razorpay_payment_id}`
      );

      if (expected !== razorpay_signature) {
        return Response.json(
          { error: "Invalid payment signature." },
          { status: 400 }
        );
      }

      const db = ctx.supabaseAdmin;

      // 2. Find the payment record
      const { data: payment, error: payErr } = await db
        .from("tournament_payments")
        .select("id,registration_id")
        .eq("razorpay_order_id", razorpay_order_id)
        .maybeSingle();

      if (payErr) {
        console.error(payErr);
        return Response.json({ error: "Could not load payment." }, { status: 500 });
      }
      if (!payment) {
        return Response.json({ error: "Payment record not found." }, { status: 404 });
      }

      // 3. Make sure this registration belongs to the logged-in player
      const { data: reg, error: regErr } = await db
        .from("tournament_registrations")
        .select("id,player_id")
        .eq("id", payment.registration_id)
        .maybeSingle();

      if (regErr || !reg) {
        return Response.json({ error: "Registration not found." }, { status: 404 });
      }
      if (reg.player_id !== playerId) {
        return Response.json({ error: "Not your registration." }, { status: 403 });
      }

      // 4. Mark paid, then approve
      const { error: upPayErr } = await db
        .from("tournament_payments")
        .update({
          payment_status: "PAID",
          razorpay_payment_id,
        })
        .eq("id", payment.id);

      if (upPayErr) {
        console.error(upPayErr);
        return Response.json({ error: "Could not update payment." }, { status: 500 });
      }

      const { error: upRegErr } = await db
        .from("tournament_registrations")
        .update({ registration_status: "APPROVED" })
        .eq("id", reg.id);

      if (upRegErr) {
        console.error(upRegErr);
        return Response.json({ error: "Could not approve registration." }, { status: 500 });
      }

      return Response.json({ success: true });
    } catch (error) {
      console.error("verify-payment error:", error);
      return Response.json({ error: "Unexpected server error." }, { status: 500 });
    }
  }),
};
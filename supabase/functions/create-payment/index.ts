
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

interface PaymentRequest {
  tournament_id: string;
  player_uid: string;
  phone_number: string;
  team_name?: string | null;
  teammates?: string | null;
  rules_accepted: boolean;
}

const handler = withSupabase(
  { auth: "user" },
  async (req, ctx) => {
    try {
      if (req.method !== "POST") {
        return Response.json(
          { error: "Only POST requests are allowed." },
          { status: 405 }
        );
      }

      const body: PaymentRequest = await req.json();

      const tournamentId = body.tournament_id?.trim();
      const playerUid = body.player_uid?.trim();
      const phone = body.phone_number?.replace(/\s+/g, "");

      if (!tournamentId || !playerUid || !phone) {
        return Response.json(
          { error: "Required registration details are missing." },
          { status: 400 }
        );
      }

      if (!/^[6-9]\d{9}$/.test(phone)) {
        return Response.json(
          { error: "Enter a valid 10-digit Indian mobile number." },
          { status: 400 }
        );
      }

      if (body.rules_accepted !== true) {
        return Response.json(
          { error: "Please accept the tournament rules." },
          { status: 400 }
        );
      }

      const playerId =
        (ctx.userClaims as any)?.id ??
        (ctx.userClaims as any)?.sub;

      if (!playerId) {
        return Response.json(
          { error: "Please log in again." },
          { status: 401 }
        );
      }

      const keyId = Deno.env.get("RAZORPAY_KEY_ID");
      const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");

      if (!keyId || !keySecret) {
        return Response.json(
          { error: "Payment service is not configured." },
          { status: 500 }
        );
      }

      const db = ctx.supabaseAdmin;

      const { data: tournament, error: tournamentError } =
        await db
          .from("tournaments")
          .select("id,title,entry_fee,status,game_mode")
          .eq("id", tournamentId)
          .maybeSingle();

      if (tournamentError) {
        console.error(tournamentError);
        return Response.json(
          { error: "Could not load tournament." },
          { status: 500 }
        );
      }

      if (!tournament) {
        return Response.json(
          { error: "Tournament not found." },
          { status: 404 }
        );
      }

      if (tournament.status !== "OPEN") {
        return Response.json(
          { error: "Tournament registration is closed." },
          { status: 400 }
        );
      }

      const teamName = body.team_name?.trim() || "";
      const teammates = body.teammates?.trim() || "";

      if (
        tournament.game_mode !== "SOLO" &&
        (!teamName || !teammates)
      ) {
        return Response.json(
          { error: "Team name and teammate details are required." },
          { status: 400 }
        );
      }

      const fee = Number(tournament.entry_fee);
      const amountPaise = Math.round(fee * 100);

      if (
        !Number.isFinite(fee) ||
        fee <= 0 ||
        !Number.isSafeInteger(amountPaise) ||
        amountPaise <= 0
      ) {
        return Response.json(
          { error: "Invalid tournament entry fee." },
          { status: 400 }
        );
      }

      // Find an existing registration before creating a new one.
      const { data: existing, error: existingError } =
        await db
          .from("tournament_registrations")
          .select(
            "id,registration_status,player_uid,phone_number,team_name,teammates"
          )
          .eq("tournament_id", tournamentId)
          .eq("player_id", playerId)
          .maybeSingle();

      if (existingError) {
        console.error(existingError);
        return Response.json(
          { error: "Could not check existing registration." },
          { status: 500 }
        );
      }

      let registrationId: string;

      if (existing) {
        if (existing.registration_status !== "PENDING") {
          return Response.json(
            {
              error:
                "This registration is already processed. Contact the administrator."
            },
            { status: 409 }
          );
        }

        // Do not allow the retry request to change registration details.
        if (
          existing.player_uid !== playerUid ||
          existing.phone_number !== phone ||
          (existing.team_name || "") !== teamName ||
          (existing.teammates || "") !== teammates
        ) {
          return Response.json(
            {
              error:
                "Your existing pending registration has different details. Contact the administrator."
            },
            { status: 409 }
          );
        }

        registrationId = existing.id;

        // Look for the latest payment record for this registration.
        const { data: oldPayment, error: oldPaymentError } =
          await db
            .from("tournament_payments")
            .select(
              "id,razorpay_order_id,amount_paise,currency,payment_status"
            )
            .eq("registration_id", registrationId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (oldPaymentError) {
          console.error(oldPaymentError);
          return Response.json(
            { error: "Could not check existing payment." },
            { status: 500 }
          );
        }

        if (oldPayment) {
          if (
            oldPayment.payment_status === "PAID"
          ) {
            return Response.json(
              {
                error:
                  "Payment is already recorded. Please wait for registration confirmation or contact the administrator."
              },
              { status: 409 }
            );
          }

          if (
            oldPayment.payment_status !== "CREATED" ||
            oldPayment.amount_paise !== amountPaise ||
            oldPayment.currency !== "INR"
          ) {
            return Response.json(
              {
                error:
                  "The previous payment needs administrator review. Please do not make another payment."
              },
              { status: 409 }
            );
          }

          // Verify that the existing order still exists in Razorpay.
          const orderCheck = await fetch(
            `https://api.razorpay.com/v1/orders/${encodeURIComponent(
              oldPayment.razorpay_order_id
            )}`,
            {
              method: "GET",
              headers: {
                Authorization:
                  `Basic ${btoa(`${keyId}:${keySecret}`)}`
              }
            }
          );

          const checkedOrder = await orderCheck.json();

          if (!orderCheck.ok) {
            console.error(checkedOrder);
            return Response.json(
              {
                error:
                  "Could not verify the existing Razorpay order. Contact the administrator."
              },
              { status: 502 }
            );
          }

          if (
            checkedOrder.amount !== amountPaise ||
            checkedOrder.currency !== "INR"
          ) {
            return Response.json(
              {
                error:
                  "Existing payment order details do not match. Contact the administrator."
              },
              { status: 409 }
            );
          }

          if (checkedOrder.status === "paid") {
            return Response.json(
              {
                error:
                  "Razorpay shows this order as paid, but confirmation is pending. Do not pay again. Contact the administrator."
              },
              { status: 409 }
            );
          }

          if (
            checkedOrder.status !== "created" &&
            checkedOrder.status !== "attempted"
          ) {
            return Response.json(
              {
                error:
                  "The existing Razorpay order cannot be reused. Contact the administrator."
              },
              { status: 409 }
            );
          }

          // Reuse the existing order. Do not create another one.
          return Response.json({
            success: true,
            reused: true,
            registration_id: registrationId,
            razorpay_order_id: oldPayment.razorpay_order_id,
            razorpay_key_id: keyId,
            amount: amountPaise,
            currency: "INR",
            tournament_title: tournament.title
          });
        }

        // Existing pending registration has no payment record.
        // Continue below and create an order for this same registration.
      } else {
        const { data: registration, error: registrationError } =
          await db
            .from("tournament_registrations")
            .insert({
              tournament_id: tournamentId,
              player_id: playerId,
              player_uid: playerUid,
              phone_number: phone,
              team_name: teamName || null,
              teammates: teammates || null,
              rules_accepted: true,
              registration_status: "PENDING"
            })
            .select("id")
            .single();

        if (registrationError || !registration) {
          console.error(registrationError);
          return Response.json(
            { error: "Could not create registration." },
            { status: 400 }
          );
        }

        registrationId = registration.id;
      }

      // Create a Razorpay order for the registration.
      const receipt =
        `v1_${registrationId.replaceAll("-", "").slice(0, 32)}`;

      const razorpayResponse = await fetch(
        "https://api.razorpay.com/v1/orders",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization:
              `Basic ${btoa(`${keyId}:${keySecret}`)}`
          },
          body: JSON.stringify({
            amount: amountPaise,
            currency: "INR",
            receipt,
            notes: {
              registration_id: registrationId,
              tournament_id: tournamentId,
              player_id: playerId
            }
          })
        }
      );

      const razorpayOrder = await razorpayResponse.json();

      if (!razorpayResponse.ok || !razorpayOrder.id) {
        console.error(razorpayOrder);
        return Response.json(
          {
            error:
              razorpayOrder?.error?.description ||
              "Could not create Razorpay order."
          },
          { status: 502 }
        );
      }

      const { error: paymentError } = await db
        .from("tournament_payments")
        .insert({
          registration_id: registrationId,
          razorpay_order_id: razorpayOrder.id,
          amount_paise: amountPaise,
          currency: "INR",
          payment_status: "CREATED"
        });

      if (paymentError) {
        console.error(paymentError);

        // Do not delete the registration or order here.
        // They may need administrator reconciliation.
        return Response.json(
          {
            error:
              "Razorpay order was created, but saving its payment record failed. Contact the administrator and do not pay again."
          },
          { status: 500 }
        );
      }

      return Response.json({
        success: true,
        reused: false,
        registration_id: registrationId,
        razorpay_order_id: razorpayOrder.id,
        razorpay_key_id: keyId,
        amount: amountPaise,
        currency: "INR",
        tournament_title: tournament.title
      });

    } catch (error) {
      console.error("create-payment error:", error);

      return Response.json(
        { error: "Unexpected server error." },
        { status: 500 }
      );
    }
  }
);

export default {
  fetch: handler
};

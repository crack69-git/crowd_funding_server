import dns from "dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import express from "express";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import cors from "cors";
import SSLCommerzPayment from "sslcommerz-lts";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
// SSLCommerz redirects send POST data as urlencoded form data
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGO_URI);
const store_id = process.env.STORE_ID;
const store_passwd = process.env.STORE_PASSWORD;

// Convert environment string to strict boolean
const is_live = process.env.IS_LIVE === "true";

async function startServer() {
  try {
    await client.connect();

    console.log("You successfully connected to MongoDB!");

    const db = client.db(process.env.DB);
    const usersCollection = db.collection("user");
    const campaignsCollection = db.collection("campaigns");
    const tiersCollection = db.collection("tiers");
    const ordersCollection = db.collection("orders"); // Added Orders collection

    // paymentHistory
    app.get("/api/paymentHistory/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const result = await ordersCollection
          .aggregate([
            {
              $match: {
                cus_email: email,
              },
            },
            {
              $group: {
                _id: null,
                totalAmountSpent: { $sum: "$total_amount" },
                totalCreditPurchased: { $sum: "$amount_converted" },
              },
            },
          ])

          .toArray();
        console.log("Payment history result:", result);
        res.json({
          totalAmountSpent: result[0]?.totalAmountSpent || 0,
          totalCreditPurchased: result[0]?.totalCreditPurchased || 0,
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({
          error: "Failed to fetch payment statistics.",
        });
      }
    });

    // getSingleCampaign
    app.get("/api/getSingleCampaign/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const campaign = await campaignsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!campaign) {
          return res.status(404).json({ error: "Campaign not found" });
        }
        res.json(campaign);
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // getUserByMail
    app.get("/api/getUserByMail/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        res.json(user);
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // patchUserInfo
    app.patch("/api/patchUserInfo/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { credit } = req.body;
        console.log("req body:", req.body);

        const result = await usersCollection.updateOne(
          { email },
          { $set: { credit } },
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    app.get("/api/getOrders/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const orders = await ordersCollection
          .find({ cus_email: email })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(orders);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch orders." });
      }
    });

    // =========================================================
    // 1. SSLCOMMERZ: INITIATE PAYMENT
    // =========================================================
    app.post("/api/payment/init", async (req, res) => {
      console.log("Received payment initiation request:", req.body);
      const {
        total_amount,
        amount_converted,
        cus_name,
        cus_email,
        product_name,
      } = req.body;

      const tran_id = `REF_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

      try {
        // A. Save order details to MongoDB as 'PENDING'
        const initialOrder = {
          tran_id,
          total_amount: Number(total_amount),
          amount_converted: Number(amount_converted),
          product_name,
          cus_name,
          cus_email,

          status: "PENDING",
          createdAt: new Date(),
        };

        await ordersCollection.insertOne(initialOrder);

        // B. Prepare data for SSLCommerz
        const data = {
          total_amount: Number(total_amount),
          amount_converted: Number(amount_converted),
          currency: "BDT",
          tran_id: tran_id,
          success_url: `http://localhost:${port}/api/payment/success?tran_id=${tran_id}`,
          fail_url: `http://localhost:${port}/api/payment/fail?tran_id=${tran_id}`,
          cancel_url: `http://localhost:${port}/api/payment/cancel?tran_id=${tran_id}`,
          ipn_url: `http://localhost:${port}/api/payment/ipn`,
          shipping_method: "Courier",
          product_name: product_name || "Item",
          product_category: "General",
          product_profile: "general",
          cus_name: cus_name,
          cus_email: cus_email,
          cus_add1: "Dhaka",
          cus_add2: "Dhaka",
          cus_city: "Dhaka",
          cus_state: "Dhaka",
          cus_postcode: "1000",
          cus_country: "Bangladesh",
          cus_phone: "phone",
          cus_fax: "01700000000",
          ship_name: cus_name,
          ship_add1: "Dhaka",
          ship_add2: "Dhaka",
          ship_city: "Dhaka",
          ship_state: "Dhaka",
          ship_postcode: 1000,
          ship_country: "Bangladesh",
        };

        const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
        const apiResponse = await sslcz.init(data);

        if (apiResponse?.GatewayPageURL) {
          return res.json({
            url: apiResponse.GatewayPageURL,
          });
        }

        await ordersCollection.deleteOne({ tran_id });

        return res.status(400).json({
          error: "Failed to create payment session.",
          details: apiResponse,
        });
      } catch (error) {
        await ordersCollection.deleteOne({ tran_id });
        return res.status(500).json({
          error: "Internal Server Error",
          details: error.message,
        });
      }
    });

    // =========================================================
    // 2. SSLCOMMERZ: SUCCESS CALLBACK
    // =========================================================
    app.post("/api/payment/success", async (req, res) => {
      const { tran_id } = req.query;
      const { val_id, card_type } = req.body;

      try {
        const sslcz = new SSLCommerzPayment(store_id, store_passwd, is_live);
        const validationData = await sslcz.validate({ val_id });

        if (
          validationData.status === "VALID" ||
          validationData.status === "VALIDATED"
        ) {
          // Update order status to 'PAID' in MongoDB
          await ordersCollection.updateOne(
            { tran_id },
            {
              $set: {
                status: "PAID",
                val_id,
                card_type: card_type || validationData.card_type,
                paidAt: new Date(),
              },
            },
          );

          // Redirect user back to Next.js success page
          return res.redirect(
            `${process.env.BASE_URL}/payment/success?tran_id=${tran_id}`,
          );
        } else {
          await ordersCollection.updateOne(
            { tran_id },
            { $set: { status: "FAILED" } },
          );
          return res.redirect(
            `${process.env.BASE_URL}/payment/failure?tran_id=${tran_id}`,
          );
        }
      } catch (error) {
        await ordersCollection.updateOne(
          { tran_id },
          { $set: { status: "FAILED" } },
        );
        return res.redirect(
          `${process.env.BASE_URL}/payment/failure?tran_id=${tran_id}`,
        );
      }
    });

    // =========================================================
    // 3. SSLCOMMERZ: FAIL CALLBACK
    // =========================================================
    app.post("/api/payment/fail", async (req, res) => {
      const { tran_id } = req.query;
      await ordersCollection.updateOne(
        { tran_id },
        { $set: { status: "FAILED" } },
      );
      return res.redirect(
        `${process.env.BASE_URL}/payment/failure?tran_id=${tran_id}`,
      );
    });

    // =========================================================
    // 4. SSLCOMMERZ: CANCEL CALLBACK
    // =========================================================
    app.post("/api/payment/cancel", async (req, res) => {
      const { tran_id } = req.query;
      await ordersCollection.updateOne(
        { tran_id },
        { $set: { status: "CANCELLED" } },
      );
      return res.redirect(
        `${process.env.BASE_URL}/payment/cancel?tran_id=${tran_id}`,
      );
    });

    // =========================================================
    // 5. GET ORDER BY TRAN_ID (for Next.js Success Screen)
    // =========================================================
    app.get("/api/orders/:tran_id", async (req, res) => {
      try {
        const tran_id = req.params.tran_id;
        const order = await ordersCollection.findOne({ tran_id });
        if (!order) {
          return res.status(404).json({ error: "Order not found" });
        }
        res.json(order);
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // --- Campaign & User Routes ---

    // patchCampaignState
    app.patch("/api/patchCampaignState/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { state } = req.body;

        const result = await campaignsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { state } },
        );
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // getAdminCampaigns
    app.get("/api/getAdminCampaigns", async (req, res) => {
      try {
        const campaigns = await campaignsCollection
          .find({})
          .sort({ dateCreated: -1 })
          .toArray();
        res.json(campaigns);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // getAllCampaigns
    app.get("/api/getAllCampaigns", async (req, res) => {
      try {
        const campaigns = await campaignsCollection
          .find({ state: "approved" })
          .toArray();
        res.json(campaigns);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // getMyCampaigns
    app.get("/api/getMyCampaigns/:userId", async (req, res) => {
      try {
        const userId = req.params.userId;
        const campaigns = await campaignsCollection
          .find({ creatorId: userId })
          .toArray();
        res.json(campaigns);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // postTier
    app.post("/api/posttiers", async (req, res) => {
      try {
        const tier = req.body;
        const result = await tiersCollection.insertOne(tier);
        res.status(201).json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // getTiers
    app.get("/api/getTiers", async (req, res) => {
      try {
        const tiers = await tiersCollection.find().toArray();
        res.json(tiers);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // postCampaign
    app.post("/api/postcampaign", async (req, res) => {
      try {
        const campaign = req.body;
        const result = await campaignsCollection.insertOne(campaign);
        res.status(201).json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    app.get("/", (req, res) => {
      res.send("Hello World!");
    });

    // DeleteSingleUser
    app.delete("/api/deletesingleuser/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // getAllUsers
    app.get("/api/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.json(users);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Start server only after MongoDB connection
    app.listen(port, () => {
      console.log(`Example app listening on port ${port}`);
    });
  } catch (err) {
    console.error("MongoDB connection failed:", err);
  }
}

startServer();

import dns from "dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import express from "express";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import cors from "cors";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const port = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGO_URI);

async function startServer() {
  try {
    await client.connect();

    console.log("You successfully connected to MongoDB!");

    const db = client.db(process.env.DB);
    const usersCollection = db.collection("user");
    const campaignsCollection = db.collection("campaigns");
    const tiersCollection = db.collection("tiers");

    // postTier
    app.post("/api/posttiers", async (req, res) => {
      try {
        const tier = req.body;
        console.log(tier);
        const result = await tiersCollection.insertOne(tier);
        res.status(201).json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({
          error: "Internal Server Error",
        });
      }
    });

    // getTiers
    app.get("/api/getTiers", async (req, res) => {
      try {
        const tiers = await tiersCollection.find().toArray();
        res.json(tiers);
      } catch (err) {
        console.error(err);
        res.status(500).json({
          error: "Internal Server Error",
        });
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
        res.status(500).json({
          error: "Internal Server Error",
        });
      }
    });

    app.get("/", (req, res) => {
      res.send("Hello World!");
    });

    app.get("/api/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.json(users);
      } catch (err) {
        console.error(err);
        res.status(500).json({
          error: "Internal Server Error",
        });
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

// api/index.js - Vercel Serverless Function for Bots.Business & Channel Check
const FIREBASE_URL = "https://smartu-grup-bot-default-rtdb.firebaseio.com";

async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`);
  return await res.json();
}

async function fbSet(path, data) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return await res.json();
}

async function fbUpdate(path, data) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return await res.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const params = req.method === "POST" ? { ...req.query, ...req.body } : req.query;
    const action = params.action || "profile";
    const userId = String(params.userid || params.user_id || "").trim();

    // 1. CHECK TELEGRAM CHANNEL MEMBERSHIP
    if (action === "check_channel") {
      if (!userId) return res.status(400).json({ status: false, message: "Missing userid" });

      const config = (await fbGet("config")) || {};
      const botToken = params.bot_token || config.botToken || "";
      const channelId = params.channel_id || config.channelUsername || "";

      if (!botToken || !channelId) {
        // Jar admin panel madhe ajun token/channel set nसेल tar allow kara
        return res.status(200).json({ status: true, joined: true, note: "Channel config not set yet" });
      }

      const tgUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(channelId)}&user_id=${userId}`;
      const tgRes = await fetch(tgUrl);
      const tgData = await tgRes.json();

      if (!tgData.ok) {
        return res.status(200).json({ status: true, joined: false, error: tgData.description });
      }

      const memberStatus = tgData.result.status;
      const isJoined = ["creator", "administrator", "member", "restricted"].includes(memberStatus);

      await fbUpdate(`users/${userId}`, { channelJoined: isJoined, lastChecked: Date.now() });
      return res.status(200).json({ status: true, joined: isJoined, memberStatus });
    }

    // 2. GET OR CREATE USER PROFILE (Bots.Business /start or My Profile)
    if (action === "profile" || action === "get_balance") {
      if (!userId) return res.status(400).json({ status: false, message: "User ID required" });

      let user = await fbGet(`users/${userId}`);
      if (!user) {
        user = {
          userId: userId,
          coins: 0,
          cash: 0,
          upi: "Not Set",
          status: "Verified & Secure ✅",
          deviceId: "",
          referredBy: params.ref || "",
          referCount: 0,
          banned: false,
          createdAt: Date.now()
        };
        await fbSet(`users/${userId}`, user);

        // Referral Bonus logic
        if (params.ref && params.ref !== userId) {
          let refUser = await fbGet(`users/${params.ref}`);
          if (refUser) {
            const bonusCoins = 200; // 200 coins per refer
            await fbUpdate(`users/${params.ref}`, {
              coins: Number(refUser.coins || 0) + bonusCoins,
              referCount: Number(refUser.referCount || 0) + 1
            });
          }
        }
      }

      return res.status(200).json({
        status: true,
        userId: user.userId || userId,
        coins: Number(user.coins || 0),
        cash: Number(user.cash || 0),
        upi: user.upi || "Not Set",
        accountStatus: user.banned ? "Banned ❌" : "Verified & Secure ✅",
        rate: "100 Coins = ₹1",
        referCount: Number(user.referCount || 0)
      });
    }

    // 3. UPDATE UPI ID FROM BOT
    if (action === "set_upi") {
      if (!userId || !params.upi) return res.status(400).json({ status: false, message: "Missing userid or upi" });
      await fbUpdate(`users/${userId}`, { upi: params.upi });
      return res.status(200).json({ status: true, message: "UPI ID Updated Successfully", upi: params.upi });
    }

    // 4. CONVERT COINS TO CASH FROM BOT OR WEBSITE (100 Coins = ₹1)
    if (action === "convert") {
      if (!userId) return res.status(400).json({ status: false, message: "Missing userid" });
      let user = await fbGet(`users/${userId}`);
      if (!user) return res.status(404).json({ status: false, message: "User not found" });

      let coins = Number(user.coins || 0);
      if (coins < 100) {
        return res.status(200).json({ status: false, message: "Minimum 100 Coins required to convert!" });
      }

      let convertibleRupees = Math.floor(coins / 100);
      let remainingCoins = coins % 100;
      let newCash = Number((Number(user.cash || 0) + convertibleRupees).toFixed(2));

      await fbUpdate(`users/${userId}`, {
        coins: remainingCoins,
        cash: newCash
      });

      return res.status(200).json({
        status: true,
        message: `Converted ${convertibleRupees * 100} Coins to ₹${convertibleRupees}`,
        coins: remainingCoins,
        cash: newCash
      });
    }

    // 5. DAILY TASK BONUS FROM BOT
    if (action === "daily_bonus") {
      if (!userId) return res.status(400).json({ status: false, message: "Missing userid" });
      let user = await fbGet(`users/${userId}`);
      if (!user) return res.status(404).json({ status: false, message: "User not found" });

      const now = Date.now();
      const lastDaily = Number(user.lastDaily || 0);
      if (now - lastDaily < 86400000) {
        return res.status(200).json({ status: false, message: "You already claimed your Daily Task today! Come back tomorrow." });
      }

      const reward = Number(params.reward || 100);
      const newCoins = Number(user.coins || 0) + reward;
      await fbUpdate(`users/${userId}`, { coins: newCoins, lastDaily: now });

      return res.status(200).json({ status: true, message: `Daily Bonus +${reward} Coins added!`, coins: newCoins });
    }

    // 6. REDEEM GIFT CODE FROM BOT OR WEB
    if (action === "redeem_gift") {
      const code = String(params.code || "").trim().toUpperCase();
      if (!userId || !code) return res.status(400).json({ status: false, message: "Missing userid or code" });

      const gift = await fbGet(`giftCodes/${code}`);
      if (!gift) return res.status(200).json({ status: false, message: "Invalid Gift Code!" });
      if (Number(gift.usedCount || 0) >= Number(gift.maxUsers || 1)) {
        return res.status(200).json({ status: false, message: "Gift Code Limit Expired!" });
      }
      if (gift.claimedBy && gift.claimedBy[userId]) {
        return res.status(200).json({ status: false, message: "You have already redeemed this Gift Code!" });
      }

      const user = (await fbGet(`users/${userId}`)) || { coins: 0, cash: 0 };
      const rewardCoins = Number(gift.coins || 0);
      const newCoins = Number(user.coins || 0) + rewardCoins;

      await fbUpdate(`users/${userId}`, { coins: newCoins });
      await fbUpdate(`giftCodes/${code}`, { usedCount: Number(gift.usedCount || 0) + 1 });
      await fbSet(`giftCodes/${code}/claimedBy/${userId}`, true);

      return res.status(200).json({
        status: true,
        message: `Success! You received ${rewardCoins} Coins!`,
        coins: newCoins
      });
    }

    // 7. WITHDRAWAL REQUEST FROM BOT
    if (action === "withdraw") {
      const amount = Number(params.amount || 0);
      if (!userId || amount <= 0) return res.status(400).json({ status: false, message: "Invalid withdrawal amount" });

      const user = await fbGet(`users/${userId}`);
      if (!user) return res.status(404).json({ status: false, message: "User not found" });
      if (!user.upi || user.upi === "Not Set") {
        return res.status(200).json({ status: false, message: "Please set your UPI ID in Profile Settings first!" });
      }
      if (Number(user.cash || 0) < amount) {
        return res.status(200).json({ status: false, message: "Insufficient Real Cash balance!" });
      }

      const newCash = Number((Number(user.cash) - amount).toFixed(2));
      const reqId = "WDR_" + Date.now();

      await fbUpdate(`users/${userId}`, { cash: newCash });
      await fbSet(`withdrawals/${reqId}`, {
        id: reqId,
        userId,
        amount,
        upi: user.upi,
        status: "Pending",
        timestamp: Date.now()
      });

      return res.status(200).json({
        status: true,
        message: `Withdrawal of ₹${amount} to ${user.upi} submitted successfully!`,
        cash: newCash,
        withdrawalId: reqId
      });
    }

    return res.status(200).json({ status: true, message: "SMARTU API is Running" });
  } catch (error) {
    return res.status(500).json({ status: false, error: error.message });
  }
}

// api/index.js - Complete Serverless Backend API for SMARTU Wallet & Bots.Business
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

async function getSystemConfig() {
  const cfg = (await fbGet("config")) || {};
  return {
    botToken: cfg.botToken || "",
    botUsername: cfg.botUsername || "Smartu_grup_bot",
    referReward: Number(cfg.referReward !== undefined ? cfg.referReward : 200),
    conversionRate: Number(cfg.conversionRate || 100), // 100 Coins = ₹1
    minWithdraw: Number(cfg.minWithdraw || 10),
    maxWithdraw: Number(cfg.maxWithdraw || 5000),
    gamesEnabled: cfg.gamesEnabled !== undefined ? Boolean(cfg.gamesEnabled) : true,
    gamePlayLimit: Number(cfg.gamePlayLimit || 50),
    aviatorMaxBet: Number(cfg.aviatorMaxBet || 5000),
    channels: Array.isArray(cfg.channels) ? cfg.channels : []
  };
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
    const action = String(params.action || "profile").trim();
    const userId = String(params.userid || params.user_id || "").trim();

    const config = await getSystemConfig();

    // 1. MULTI-CHANNEL MEMBERSHIP VERIFICATION + AUTO REFERRAL UNLOCK
    if (action === "check_channel") {
      if (!userId) {
        return res.status(400).json({ status: false, message: "User ID is required." });
      }

      const channels = config.channels || [];
      const botToken = params.bot_token || config.botToken;

      let allJoined = true;
      let missingChannels = [];

      if (channels.length > 0 && botToken) {
        for (let i = 0; i < channels.length; i++) {
          const ch = channels[i];
          if (!ch || !ch.id) continue;
          try {
            const tgUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(ch.id)}&user_id=${userId}`;
            const tgRes = await fetch(tgUrl);
            const tgData = await tgRes.json();

            if (tgData.ok && tgData.result) {
              const st = tgData.result.status;
              const joined = ["creator", "administrator", "member", "restricted"].includes(st);
              if (!joined) {
                allJoined = false;
                missingChannels.push(ch);
              }
            } else {
              allJoined = false;
              missingChannels.push(ch);
            }
          } catch (e) {
            // Network fallback
          }
        }
      }

      // Check and process pending Referral Reward ONLY if:
      // a) All channels are joined
      // b) Device is unique (passed from web verification)
      // c) Referral reward hasn't been claimed yet
      let referralCredited = false;
      let referralBonusAmount = 0;

      if (allJoined) {
        const user = await fbGet(`users/${userId}`);
        const deviceUnique = params.device_unique !== "false";

        if (
          user &&
          user.referredBy &&
          String(user.referredBy) !== String(userId) &&
          !user.referralRewardPaid &&
          deviceUnique
        ) {
          const referrerId = String(user.referredBy);
          const referrerData = await fbGet(`users/${referrerId}`);

          if (referrerData && (!user.deviceId || user.deviceId !== referrerData.deviceId)) {
            referralBonusAmount = Number(config.referReward || 200);
            const updatedRefCoins = Number(referrerData.coins || 0) + referralBonusAmount;
            const updatedRefCount = Number(referrerData.referCount || 0) + 1;

            await fbUpdate(`users/${referrerId}`, {
              coins: updatedRefCoins,
              referCount: updatedRefCount
            });

            await fbUpdate(`users/${userId}`, {
              referralRewardPaid: true,
              channelJoined: true,
              lastChecked: Date.now()
            });

            referralCredited = true;

            // Optional Telegram Notification to Referrer
            if (botToken) {
              const notifyText = `🎉 *New Referral Verified!*\n\n👤 *User ID:* \`${userId}\` joined the required channels & opened the app!\n🪙 *Reward Added:* +${referralBonusAmount} Coins`;
              await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: referrerId,
                  text: notifyText,
                  parse_mode: "Markdown"
                })
              }).catch(() => {});
            }
          } else {
            // Same device detected, mark as processed without paying
            await fbUpdate(`users/${userId}`, { referralRewardPaid: "blocked_same_device" });
          }
        } else if (user) {
          await fbUpdate(`users/${userId}`, { channelJoined: true, lastChecked: Date.now() });
        }
      }

      return res.status(200).json({
        status: true,
        joined: allJoined,
        channels: channels,
        missingChannels: missingChannels,
        referralCredited,
        referralBonusAmount
      });
    }

    // 2. GET OR INITIALIZE USER PROFILE
    if (action === "profile" || action === "get_balance") {
      if (!userId) {
        return res.status(400).json({ status: false, message: "Missing User ID!" });
      }

      let user = await fbGet(`users/${userId}`);
      const refParam = String(params.ref || "").trim();

      if (!user) {
        user = {
          userId: userId,
          coins: 0,
          cash: 0,
          upi: "Not Set",
          status: "Verified & Secure ✅",
          deviceId: "",
          referredBy: (refParam && refParam !== userId) ? refParam : "",
          referralRewardPaid: false,
          referCount: 0,
          gamesPlayedToday: 0,
          lastGameDate: new Date().toISOString().slice(0, 10),
          banned: false,
          createdAt: Date.now()
        };
        await fbSet(`users/${userId}`, user);
      } else if (refParam && !user.referredBy && refParam !== userId && !user.referralRewardPaid) {
        await fbUpdate(`users/${userId}`, { referredBy: refParam });
        user.referredBy = refParam;
      }

      return res.status(200).json({
        status: true,
        userId: user.userId || userId,
        coins: Number(user.coins || 0),
        cash: Number(user.cash || 0),
        upi: user.upi || "Not Set",
        banned: Boolean(user.banned),
        accountStatus: user.banned ? "Banned 🚫" : "Verified & Secure ✅",
        rate: `${config.conversionRate} Coins = ₹1`,
        conversionRate: config.conversionRate,
        referCount: Number(user.referCount || 0),
        config: config
      });
    }

    // 3. CONVERT CUSTOM COINS TO CASH
    if (action === "convert") {
      if (!userId) {
        return res.status(400).json({ status: false, message: "User ID required." });
      }
      const user = await fbGet(`users/${userId}`);
      if (!user) {
        return res.status(404).json({ status: false, message: "Account not found." });
      }
      if (user.banned) {
        return res.status(403).json({ status: false, message: "Your account is banned." });
      }

      const rate = Number(config.conversionRate || 100);
      const userCoins = Number(user.coins || 0);
      const requestedCoins = params.coins ? Number(params.coins) : userCoins;

      if (isNaN(requestedCoins) || requestedCoins < rate) {
        return res.status(200).json({
          status: false,
          message: `Minimum ${rate} Coins required to convert!`
        });
      }

      if (requestedCoins > userCoins) {
        return res.status(200).json({
          status: false,
          message: "Insufficient Market Coins in your wallet!"
        });
      }

      const cashEarned = Number((requestedCoins / rate).toFixed(2));
      const newCoins = Math.floor(userCoins - requestedCoins);
      const newCash = Number((Number(user.cash || 0) + cashEarned).toFixed(2));

      await fbUpdate(`users/${userId}`, {
        coins: newCoins,
        cash: newCash
      });

      return res.status(200).json({
        status: true,
        message: `Successfully converted ${requestedCoins} Coins into ₹${cashEarned}!`,
        convertedCoins: requestedCoins,
        cashAdded: cashEarned,
        coins: newCoins,
        cash: newCash
      });
    }

    // 4. UPDATE UPI ID
    if (action === "set_upi") {
      if (!userId || !params.upi) {
        return res.status(400).json({ status: false, message: "User ID and UPI ID are required." });
      }
      await fbUpdate(`users/${userId}`, { upi: String(params.upi).trim() });
      return res.status(200).json({
        status: true,
        message: "UPI ID saved successfully!",
        upi: String(params.upi).trim()
      });
    }

    // 5. REDEEM GIFT CODE
    if (action === "redeem_gift") {
      const code = String(params.code || "").trim().toUpperCase();
      if (!userId || !code) {
        return res.status(400).json({ status: false, message: "Gift code is required." });
      }

      const gift = await fbGet(`giftCodes/${code}`);
      if (!gift) {
        return res.status(200).json({ status: false, message: "Invalid Gift Code!" });
      }
      if (Number(gift.usedCount || 0) >= Number(gift.maxUsers || 1)) {
        return res.status(200).json({ status: false, message: "This Gift Code has expired!" });
      }
      if (gift.claimedBy && gift.claimedBy[userId]) {
        return res.status(200).json({ status: false, message: "You have already claimed this Gift Code!" });
      }

      const user = (await fbGet(`users/${userId}`)) || { coins: 0, cash: 0 };
      const rewardCoins = Number(gift.coins || 0);
      const newCoins = Number(user.coins || 0) + rewardCoins;

      await fbUpdate(`users/${userId}`, { coins: newCoins });
      await fbUpdate(`giftCodes/${code}`, { usedCount: Number(gift.usedCount || 0) + 1 });
      await fbSet(`giftCodes/${code}/claimedBy/${userId}`, true);

      return res.status(200).json({
        status: true,
        message: `Congratulations! You received +${rewardCoins} Coins!`,
        reward: rewardCoins,
        coins: newCoins
      });
    }

    // 6. WITHDRAWAL REQUEST WITH ADMIN LIMITS
    if (action === "withdraw") {
      const amount = Number(params.amount || 0);
      if (!userId || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ status: false, message: "Enter a valid withdrawal amount." });
      }

      if (amount < config.minWithdraw) {
        return res.status(200).json({
          status: false,
          message: `Minimum withdrawal limit is ₹${config.minWithdraw}!`
        });
      }
      if (amount > config.maxWithdraw) {
        return res.status(200).json({
          status: false,
          message: `Maximum withdrawal limit is ₹${config.maxWithdraw}!`
        });
      }

      const user = await fbGet(`users/${userId}`);
      if (!user) return res.status(404).json({ status: false, message: "User not found." });
      if (user.banned) return res.status(403).json({ status: false, message: "Your account is banned." });
      if (!user.upi || user.upi === "Not Set") {
        return res.status(200).json({ status: false, message: "Please save your UPI ID in Profile Settings first!" });
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
        message: `Withdrawal of ₹${amount} to ${user.upi} submitted!`,
        cash: newCash,
        withdrawalId: reqId
      });
    }

    // 7. BROADCAST MESSAGE TO ALL USERS VIA BOT TOKEN
    if (action === "broadcast") {
      const msgText = String(params.message || "").trim();
      const botToken = params.bot_token || config.botToken;
      if (!msgText || !botToken) {
        return res.status(400).json({ status: false, message: "Bot Token and Message are required." });
      }

      const allUsers = (await fbGet("users")) || {};
      const userIds = Object.keys(allUsers);
      let sentCount = 0;

      for (let i = 0; i < userIds.length; i++) {
        const uid = userIds[i];
        try {
          const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: uid,
              text: `📢 *SMARTU Official Broadcast*\n\n${msgText}`,
              parse_mode: "Markdown"
            })
          });
          const d = await r.json();
          if (d.ok) sentCount++;
        } catch (e) {}
      }

      return res.status(200).json({
        status: true,
        message: `Broadcast delivered to ${sentCount} / ${userIds.length} users!`
      });
    }

    return res.status(200).json({ status: true, message: "SMARTU Pro API Active" });
  } catch (err) {
    return res.status(500).json({ status: false, error: err.message });
  }
}

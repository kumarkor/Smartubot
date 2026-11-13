// api/index.js - Production Serverless API Gateway for SMARTU Wallet, Bot & Admin App
const FIREBASE_DATABASE_URL = "https://smartu-grup-bot-default-rtdb.firebaseio.com";
const FIREBASE_PROJECT_ID = "smartu-grup-bot";

// ============================================================================
// 1. SAFE FIREBASE REST HELPERS
// ============================================================================
async function fbGet(path) {
  try {
    const res = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fbSet(path, data) {
  try {
    const res = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fbUpdate(path, data) {
  try {
    const res = await fetch(`${FIREBASE_DATABASE_URL}/${path}.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Automatically record Admin actions into Firebase adminHistory for the Admin App
async function logAdminAction(adminName, actionTitle, target, details) {
  try {
    const now = Date.now();
    const logId = "LOG_" + now + "_" + Math.floor(Math.random() * 1000);
    const dateStr = new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    await fbSet(`adminHistory/${logId}`, {
      id: logId,
      adminName: adminName || "Bot / Master Admin",
      action: actionTitle,
      target: String(target || "System"),
      details: String(details || ""),
      timestamp: now,
      date: dateStr
    });
  } catch (e) {}
}

// Load Global System Configuration with Safe Defaults
async function getSystemConfig() {
  const cfg = (await fbGet("config")) || {};
  return {
    botToken: cfg.botToken || "",
    botUsername: cfg.botUsername || "Smartu_grup_bot",
    payoutChannel: cfg.payoutChannel || "",
    welcomeBonus: Number(cfg.welcomeBonus !== undefined ? cfg.welcomeBonus : 100),
    referReward: Number(cfg.referReward !== undefined ? cfg.referReward : 200),
    conversionRate: Number(cfg.conversionRate || 100),
    minWithdraw: Number(cfg.minWithdraw || 10),
    maxWithdraw: Number(cfg.maxWithdraw || 5000),
    gamesEnabled: cfg.gamesEnabled !== undefined ? Boolean(cfg.gamesEnabled) : true,
    gamePlayLimit: Number(cfg.gamePlayLimit || 50),
    aviatorMaxBet: Number(cfg.aviatorMaxBet || 5000),
    channels: Array.isArray(cfg.channels) ? cfg.channels : []
  };
}

// ============================================================================
// 2. MAIN VERCEL SERVERLESS HANDLER
// ============================================================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const params = req.method === "POST" ? { ...req.query, ...req.body } : req.query;
    const action = String(params.action || "profile").trim();
    const userId = String(params.userid || params.user_id || "").trim();
    const adminName = String(params.admin_name || "Master Admin").trim();
    const config = await getSystemConfig();

    // ========================================================================
    // 1. CHECK CHANNEL JOIN & PROCESS REFERRAL REWARD (UNIQUE DEVICE ONLY)
    // ========================================================================
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
              const isMember = ["creator", "administrator", "member", "restricted"].includes(st);
              if (!isMember) {
                allJoined = false;
                missingChannels.push(ch);
              }
            } else {
              allJoined = false;
              missingChannels.push(ch);
            }
          } catch (e) {}
        }
      }

      let referralCredited = false;
      let referralBonusAmount = 0;

      if (allJoined) {
        const user = await fbGet(`users/${userId}`);
        const deviceUnique = params.device_unique !== "false";

        if (
          user &&
          user.referredBy &&
          String(user.referredBy) !== String(userId) &&
          !user.referralRewardPaid
        ) {
          if (deviceUnique) {
            const referrerId = String(user.referredBy);
            const referrerData = await fbGet(`users/${referrerId}`);

            if (referrerData && (!user.deviceId || user.deviceId !== referrerData.deviceId)) {
              referralBonusAmount = Number(config.referReward || 200);
              const updatedCoins = Number(referrerData.coins || 0) + referralBonusAmount;
              const updatedCount = Number(referrerData.referCount || 0) + 1;

              await fbUpdate(`users/${referrerId}`, {
                coins: updatedCoins,
                referCount: updatedCount
              });

              await fbUpdate(`users/${userId}`, {
                referralRewardPaid: true,
                channelJoined: true,
                lastChecked: Date.now()
              });

              referralCredited = true;

              if (botToken) {
                const msg = `🎉 *Referral Reward Unlocked!*\n\n👤 *User ID:* \`${userId}\` joined the required channels and opened the SMARTU App!\n🪙 *Reward Credited:* +${referralBonusAmount} Coins`;
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: referrerId,
                    text: msg,
                    parse_mode: "Markdown"
                  })
                }).catch(() => {});
              }
            } else {
              await fbUpdate(`users/${userId}`, { referralRewardPaid: "blocked_same_device" });
            }
          } else {
            await fbUpdate(`users/${userId}`, { referralRewardPaid: "blocked_same_device" });
          }
        } else if (user) {
          await fbUpdate(`users/${userId}`, { channelJoined: true, lastChecked: Date.now() });
        }
      }

      return res.status(200).json({
        status: true,
        joined: allJoined,
        channels,
        missingChannels,
        referralCredited,
        referralBonusAmount
      });
    }

    // ========================================================================
    // 2. USER PROFILE & WELCOME BONUS ON FIRST JOIN
    // ========================================================================
    if (action === "profile" || action === "get_balance") {
      if (!userId) {
        return res.status(400).json({ status: false, message: "Missing User ID" });
      }

      let user = await fbGet(`users/${userId}`);
      const refParam = String(params.ref || "").trim();
      let welcomeBonusCredited = false;
      let welcomeBonusAmount = Number(config.welcomeBonus || 0);

      if (!user) {
        user = {
          userId: userId,
          coins: welcomeBonusAmount,
          cash: 0,
          upi: "Not Set",
          status: "Verified & Secure ✅",
          deviceId: "",
          referredBy: (refParam && refParam !== userId) ? refParam : "",
          referralRewardPaid: false,
          welcomeBonusClaimed: true,
          referCount: 0,
          gamesPlayedToday: 0,
          lastGameDate: new Date().toISOString().slice(0, 10),
          banned: false,
          createdAt: Date.now()
        };
        await fbSet(`users/${userId}`, user);
        if (welcomeBonusAmount > 0) {
          welcomeBonusCredited = true;
        }
      } else {
        const patchData = {};
        if (refParam && !user.referredBy && refParam !== userId && !user.referralRewardPaid) {
          patchData.referredBy = refParam;
          user.referredBy = refParam;
        }
        if (
          !user.welcomeBonusClaimed &&
          welcomeBonusAmount > 0 &&
          Number(user.coins || 0) === 0 &&
          Number(user.cash || 0) === 0
        ) {
          patchData.coins = Number(user.coins || 0) + welcomeBonusAmount;
          patchData.welcomeBonusClaimed = true;
          user.coins = patchData.coins;
          welcomeBonusCredited = true;
        }
        if (Object.keys(patchData).length > 0) {
          await fbUpdate(`users/${userId}`, patchData);
        }
      }

      return res.status(200).json({
        status: true,
        projectId: FIREBASE_PROJECT_ID,
        userId: user.userId || userId,
        coins: Number(user.coins || 0),
        cash: Number(user.cash || 0),
        upi: user.upi || "Not Set",
        banned: Boolean(user.banned),
        accountStatus: user.banned ? "Banned 🚫" : "Verified & Secure ✅",
        rate: `${config.conversionRate} Coins = ₹1`,
        conversionRate: config.conversionRate,
        referReward: config.referReward,
        welcomeBonus: config.welcomeBonus,
        welcomeBonusCredited,
        welcomeBonusAmount,
        referCount: Number(user.referCount || 0),
        config
      });
    }

    // ========================================================================
    // 3. CUSTOM COIN CONVERSION (COINS -> REAL CASH)
    // ========================================================================
    if (action === "convert") {
      if (!userId) return res.status(400).json({ status: false, message: "User ID required." });
      const user = await fbGet(`users/${userId}`);
      if (!user) return res.status(404).json({ status: false, message: "User not found." });
      if (user.banned) return res.status(403).json({ status: false, message: "Your account is banned." });

      const rate = Number(config.conversionRate || 100);
      const userCoins = Number(user.coins || 0);
      const requestedCoins = params.coins !== undefined ? Number(params.coins) : userCoins;

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

      await fbUpdate(`users/${userId}`, { coins: newCoins, cash: newCash });

      return res.status(200).json({
        status: true,
        message: `Successfully converted ${requestedCoins} Coins into ₹${cashEarned}!`,
        convertedCoins: requestedCoins,
        cashAdded: cashEarned,
        coins: newCoins,
        cash: newCash
      });
    }

    // ========================================================================
    // 4. SAVE UPI ID
    // ========================================================================
    if (action === "set_upi") {
      if (!userId || !params.upi) {
        return res.status(400).json({ status: false, message: "Missing User ID or UPI ID." });
      }
      const upiClean = String(params.upi).trim();
      await fbUpdate(`users/${userId}`, { upi: upiClean });
      return res.status(200).json({
        status: true,
        message: "UPI ID saved successfully!",
        upi: upiClean
      });
    }

    // ========================================================================
    // 5. REDEEM GIFT CODE
    // ========================================================================
    if (action === "redeem_gift") {
      const code = String(params.code || "").trim().toUpperCase();
      if (!userId || !code) {
        return res.status(400).json({ status: false, message: "Gift Code is required." });
      }

      const gift = await fbGet(`giftCodes/${code}`);
      if (!gift) return res.status(200).json({ status: false, message: "Invalid Gift Code!" });
      if (Number(gift.usedCount || 0) >= Number(gift.maxUsers || 1)) {
        return res.status(200).json({ status: false, message: "This Gift Code has expired!" });
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
        message: `Success! +${rewardCoins} Coins added to your wallet!`,
        reward: rewardCoins,
        coins: newCoins
      });
    }

    // ========================================================================
    // 6. WITHDRAWAL REQUEST (SAVED FOR BOT & ANDROID ADMIN APP)
    // ========================================================================
    if (action === "withdraw") {
      const amount = Number(params.amount || 0);
      if (!userId || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ status: false, message: "Invalid withdrawal amount." });
      }
      if (amount < config.minWithdraw) {
        return res.status(200).json({ status: false, message: `Minimum withdrawal is ₹${config.minWithdraw}!` });
      }
      if (amount > config.maxWithdraw) {
        return res.status(200).json({ status: false, message: `Maximum withdrawal is ₹${config.maxWithdraw}!` });
      }

      const user = await fbGet(`users/${userId}`);
      if (!user) return res.status(404).json({ status: false, message: "User not found." });
      if (user.banned) return res.status(403).json({ status: false, message: "Your account is banned." });
      if (Number(user.cash || 0) < amount) {
        return res.status(200).json({ status: false, message: "Insufficient Real Cash balance!" });
      }

      const newCash = Number((Number(user.cash) - amount).toFixed(2));
      const reqId = String(params.req_id || ("WDR_" + Date.now())).trim();
      const upiDest = String(params.upi || user.upi || "PlayStore_Redeem_Code").trim();
      const isPlayStore = upiDest.toLowerCase().includes("playstore") || upiDest.toLowerCase().includes("redeem");

      await fbUpdate(`users/${userId}`, { cash: newCash });
      await fbSet(`withdrawals/${reqId}`, {
        id: reqId,
        userId: userId,
        userName: String(params.user_name || userId),
        type: isPlayStore ? "PLAYSTORE" : "UPI",
        method: isPlayStore ? "▶️ Google Play Store Redeem Code" : "🏦 UPI Cash Transfer",
        amount: amount,
        upi: upiDest,
        destination: upiDest,
        status: "Pending",
        timestamp: Date.now()
      });

      return res.status(200).json({
        status: true,
        message: `Withdrawal request of ₹${amount} submitted!`,
        cash: newCash,
        upi: upiDest,
        withdrawalId: reqId
      });
    }

    // Sync Withdrawal Status when Approved/Rejected from Bot Channel
    if (action === "admin_update_wdr") {
      const reqId = String(params.req_id || "").trim();
      const newStatus = String(params.status || "Approved ✅").trim();
      const processedBy = String(params.processed_by || adminName).trim();
      const redeemCode = String(params.redeem_code || "").trim();

      if (!reqId) {
        return res.status(400).json({ status: false, message: "Missing Withdrawal ID." });
      }

      const patchObj = {
        status: newStatus,
        processedBy: processedBy,
        processedAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      };
      if (redeemCode) patchObj.redeemCode = redeemCode;

      await fbUpdate(`withdrawals/${reqId}`, patchObj);
      await logAdminAction(processedBy, `Withdrawal ${newStatus}`, reqId, redeemCode ? `Redeem Code: ${redeemCode}` : `Updated status to ${newStatus}`);

      return res.status(200).json({ status: true, message: "Withdrawal status synced to Firebase!" });
    }

    // ========================================================================
    // 7. DAILY TASKS & SCREENSHOT PROOF SAVING FOR ADMIN APP & BOT
    // ========================================================================
    if (action === "get_tasks") {
      const tasksObj = (await fbGet("tasks")) || {};
      const taskList = Object.values(tasksObj);
      let userTaskStatuses = {};
      if (userId) {
        userTaskStatuses = (await fbGet(`users/${userId}/taskStatuses`)) || {};
      }
      return res.status(200).json({
        status: true,
        tasks: taskList,
        userTaskStatuses
      });
    }

    if (action === "submit_task_proof") {
      const taskId = String(params.task_id || "").trim();
      const photoFileId = String(params.photo_file_id || "").trim();
      const taskTitle = String(params.title || "Daily Task").trim();
      const coins = Number(params.coins || 100);
      const proofId = String(params.proof_id || ("PRF_" + Date.now())).trim();

      if (!userId || !taskId) {
        return res.status(400).json({ status: false, message: "Missing User ID or Task ID." });
      }

      const currentStatus = await fbGet(`users/${userId}/taskStatuses/${taskId}`);
      if (currentStatus === "Approved") {
        return res.status(200).json({ status: false, message: "You have already completed and claimed this task!" });
      }

      await fbSet(`users/${userId}/taskStatuses/${taskId}`, "Pending");
      await fbSet(`taskProofs/${proofId}`, {
        id: proofId,
        userId,
        taskId,
        taskTitle,
        coins,
        photoFileId,
        status: "Pending",
        timestamp: Date.now()
      });

      return res.status(200).json({
        status: true,
        proofId,
        message: "Task proof saved for Admin App!"
      });
    }

    if (action === "admin_approve_task") {
      const targetId = String(params.target_id || userId || "").trim();
      const taskId = String(params.task_id || "").trim();
      const proofId = String(params.proof_id || "").trim();
      const rewardCoins = Number(params.coins || 0);

      if (!targetId || !taskId) {
        return res.status(400).json({ status: false, message: "Missing Target User ID or Task ID." });
      }

      const currentSt = await fbGet(`users/${targetId}/taskStatuses/${taskId}`);
      if (currentSt === "Approved") {
        return res.status(200).json({ status: false, message: "This task was already approved!" });
      }

      const taskObj = await fbGet(`tasks/${taskId}`);
      const coinsToAdd = rewardCoins > 0 ? rewardCoins : Number((taskObj && taskObj.coins) || 0);
      const user = (await fbGet(`users/${targetId}`)) || { userId: targetId, coins: 0, cash: 0 };
      const newCoins = Number(user.coins || 0) + coinsToAdd;
      const nowTimeStr = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

      await fbUpdate(`users/${targetId}`, { coins: newCoins });
      await fbSet(`users/${targetId}/taskStatuses/${taskId}`, "Approved");

      if (proofId) {
        await fbUpdate(`taskProofs/${proofId}`, {
          status: "Approved ✅",
          processedBy: adminName,
          processedAt: nowTimeStr
        });
      } else {
        const allProofs = (await fbGet("taskProofs")) || {};
        for (const pKey in allProofs) {
          if (
            allProofs[pKey] &&
            String(allProofs[pKey].userId) === targetId &&
            String(allProofs[pKey].taskId) === taskId
          ) {
            await fbUpdate(`taskProofs/${pKey}`, {
              status: "Approved ✅",
              processedBy: adminName,
              processedAt: nowTimeStr
            });
          }
        }
      }

      await logAdminAction(adminName, "Approved Task Proof", `User ${targetId}`, `Task ${taskId} (+${coinsToAdd} Coins)`);

      return res.status(200).json({
        status: true,
        message: `Task approved! +${coinsToAdd} Coins added to User ${targetId}`,
        reward: coinsToAdd,
        coins: newCoins
      });
    }

    if (action === "admin_reject_task") {
      const targetId = String(params.target_id || userId || "").trim();
      const taskId = String(params.task_id || "").trim();
      const proofId = String(params.proof_id || "").trim();

      if (!targetId || !taskId) {
        return res.status(400).json({ status: false, message: "Missing Target User ID or Task ID." });
      }

      const nowTimeStr = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      await fbSet(`users/${targetId}/taskStatuses/${taskId}`, "Rejected");

      if (proofId) {
        await fbUpdate(`taskProofs/${proofId}`, {
          status: "Rejected ❌",
          processedBy: adminName,
          processedAt: nowTimeStr
        });
      } else {
        const allProofs = (await fbGet("taskProofs")) || {};
        for (const pKey in allProofs) {
          if (
            allProofs[pKey] &&
            String(allProofs[pKey].userId) === targetId &&
            String(allProofs[pKey].taskId) === taskId
          ) {
            await fbUpdate(`taskProofs/${pKey}`, {
              status: "Rejected ❌",
              processedBy: adminName,
              processedAt: nowTimeStr
            });
          }
        }
      }

      await logAdminAction(adminName, "Rejected Task Proof", `User ${targetId}`, `Task ${taskId}`);

      return res.status(200).json({
        status: true,
        message: `Task proof rejected for User ${targetId}`
      });
    }

    // ========================================================================
    // 8. LIVE ORDER & TASK TRACKING ENDPOINT (WDR_ / PRF_ / TSK_)
    // ========================================================================
    if (action === "track_info") {
      const trackId = String(params.id || params.track_id || "").trim().toUpperCase();
      if (!trackId) {
        return res.status(400).json({ status: false, message: "Missing Track ID." });
      }

      if (trackId.startsWith("WDR_")) {
        const wdr = await fbGet(`withdrawals/${trackId}`);
        if (!wdr) return res.status(404).json({ status: false, message: "Withdrawal ID not found." });
        return res.status(200).json({ status: true, type: "WITHDRAWAL", data: wdr });
      }

      if (trackId.startsWith("PRF_")) {
        const prf = await fbGet(`taskProofs/${trackId}`);
        if (!prf) return res.status(404).json({ status: false, message: "Task Proof ID not found." });
        return res.status(200).json({ status: true, type: "TASK_PROOF", data: prf });
      }

      if (trackId.startsWith("TSK_")) {
        const tsk = await fbGet(`tasks/${trackId}`);
        if (!tsk) return res.status(404).json({ status: false, message: "Task ID not found." });
        return res.status(200).json({ status: true, type: "TASK", data: tsk });
      }

      return res.status(404).json({ status: false, message: "Unrecognized Track ID format." });
    }

    // ========================================================================
    // 9. ADMIN PANEL API ENDPOINTS (STATS, CONFIG, BALANCES, CHANNELS, CODES)
    // ========================================================================
    if (action === "admin_stats") {
      const users = (await fbGet("users")) || {};
      const withdrawals = (await fbGet("withdrawals")) || {};
      const tasks = (await fbGet("tasks")) || {};
      const codes = (await fbGet("giftCodes")) || {};
      const proofs = (await fbGet("taskProofs")) || {};

      const uKeys = Object.keys(users);
      let totalCoins = 0;
      let totalCash = 0;
      let bannedCount = 0;

      uKeys.forEach(k => {
        totalCoins += Number(users[k].coins || 0);
        totalCash += Number(users[k].cash || 0);
        if (users[k].banned) bannedCount++;
      });

      return res.status(200).json({
        status: true,
        totalUsers: uKeys.length,
        totalCoins,
        totalCash: Number(totalCash.toFixed(2)),
        bannedCount,
        totalWithdrawals: Object.keys(withdrawals).length,
        totalTasks: Object.keys(tasks).length,
        totalTaskProofs: Object.keys(proofs).length,
        totalCodes: Object.keys(codes).length,
        config
      });
    }

    if (action === "admin_set_config") {
      const updates = {};
      if (params.welcomeBonus !== undefined) updates.welcomeBonus = Number(params.welcomeBonus);
      if (params.referReward !== undefined) updates.referReward = Number(params.referReward);
      if (params.conversionRate !== undefined) updates.conversionRate = Number(params.conversionRate);
      if (params.minWithdraw !== undefined) updates.minWithdraw = Number(params.minWithdraw);
      if (params.maxWithdraw !== undefined) updates.maxWithdraw = Number(params.maxWithdraw);
      if (params.gamesEnabled !== undefined) updates.gamesEnabled = (String(params.gamesEnabled) === "true");
      if (params.gamePlayLimit !== undefined) updates.gamePlayLimit = Number(params.gamePlayLimit);
      if (params.aviatorMaxBet !== undefined) updates.aviatorMaxBet = Number(params.aviatorMaxBet);
      if (params.botToken !== undefined) updates.botToken = String(params.botToken).trim();
      if (params.botUsername !== undefined) updates.botUsername = String(params.botUsername).trim();
      if (params.payoutChannel !== undefined) updates.payoutChannel = String(params.payoutChannel).trim();

      await fbUpdate("config", updates);
      await logAdminAction(adminName, "Updated System Config", "Firebase Config", JSON.stringify(updates));

      return res.status(200).json({
        status: true,
        message: "System configuration saved to Firebase!",
        updates
      });
    }

    if (action === "admin_modify_balance") {
      const targetId = String(params.target_id || "").trim();
      const deltaCoins = Number(params.delta_coins || 0);
      const deltaCash = Number(params.delta_cash || 0);
      if (!targetId) return res.status(400).json({ status: false, message: "Target User ID required." });

      const u = (await fbGet(`users/${targetId}`)) || { userId: targetId, coins: 0, cash: 0 };
      const newCoins = Math.max(0, Number(u.coins || 0) + deltaCoins);
      const calcCash = Number((Number(u.cash || 0) + deltaCash).toFixed(2));
      const newCash = Math.max(0, calcCash);

      await fbUpdate(`users/${targetId}`, { userId: targetId, coins: newCoins, cash: newCash });
      await logAdminAction(
        adminName,
        "Modified User Balance",
        `User ${targetId}`,
        `Coins Delta: ${deltaCoins}, Cash Delta: ₹${deltaCash} -> New Coins: ${newCoins}, New Cash: ₹${newCash}`
      );

      return res.status(200).json({
        status: true,
        message: `Balance updated for User ${targetId}! New Balance -> Coins: ${newCoins} | Cash: ₹${newCash}`,
        coins: newCoins,
        cash: newCash
      });
    }

    if (action === "admin_ban") {
      const targetId = String(params.target_id || "").trim();
      const banState = String(params.ban) !== "false";
      if (!targetId) return res.status(400).json({ status: false, message: "Target User ID required." });

      await fbUpdate(`users/${targetId}`, { banned: banState });
      await logAdminAction(adminName, banState ? "Banned User" : "Unbanned User", `User ${targetId}`, `Banned=${banState}`);

      return res.status(200).json({
        status: true,
        message: banState ? `User ${targetId} has been BANNED.` : `User ${targetId} has been UNBANNED.`
      });
    }

    if (action === "admin_banned_list") {
      const users = (await fbGet("users")) || {};
      const bannedIds = Object.keys(users).filter(k => users[k] && users[k].banned);
      return res.status(200).json({ status: true, bannedUsers: bannedIds });
    }

    if (action === "admin_add_channel") {
      const chId = String(params.channel_id || "").trim();
      const chLink = String(params.channel_link || "").trim();
      if (!chId || !chLink) return res.status(400).json({ status: false, message: "Channel ID and Link required." });

      const channels = Array.isArray(config.channels) ? config.channels : [];
      channels.push({ id: chId, link: chLink });
      const updates = { channels };
      if (params.bot_token) updates.botToken = String(params.bot_token).trim();

      await fbUpdate("config", updates);
      await logAdminAction(adminName, "Added Required Channel", chId, `Link: ${chLink}`);

      return res.status(200).json({ status: true, message: `Channel ${chId} added!`, channels });
    }

    if (action === "admin_remove_channel") {
      const chId = String(params.channel_id || "").trim();
      let channels = Array.isArray(config.channels) ? config.channels : [];
      channels = channels.filter(c => String(c.id) !== chId);

      await fbUpdate("config", { channels });
      await logAdminAction(adminName, "Removed Required Channel", chId, "Removed from force-join list");

      return res.status(200).json({ status: true, message: `Channel ${chId} removed!`, channels });
    }

    if (action === "admin_add_task") {
      const title = String(params.title || "").trim();
      const link = String(params.link || "").trim();
      const coins = Number(params.coins || 0);
      if (!title || !link || coins <= 0) {
        return res.status(400).json({ status: false, message: "Invalid task parameters." });
      }
      const id = "TSK_" + Date.now();
      const taskObj = { id, title, link, coins, createdAt: Date.now() };

      await fbSet(`tasks/${id}`, taskObj);
      await logAdminAction(adminName, "Created Daily Task", id, `${title} (+${coins} Coins)`);

      return res.status(200).json({
        status: true,
        message: `Task '${title}' (+${coins} Coins) created!`,
        task: taskObj
      });
    }

    if (action === "admin_remove_task") {
      const taskId = String(params.task_id || "").trim();
      await fbSet(`tasks/${taskId}`, null);
      await logAdminAction(adminName, "Deleted Daily Task", taskId, "Removed task from Firebase");

      return res.status(200).json({ status: true, message: `Task ${taskId} deleted!` });
    }

    if (action === "admin_create_code") {
      const code = String(params.code || "").trim().toUpperCase();
      const coins = Number(params.coins || 0);
      const maxUsers = Number(params.max_users || 1);
      if (!code || coins <= 0) return res.status(400).json({ status: false, message: "Invalid gift code parameters." });

      await fbSet(`giftCodes/${code}`, { code, coins, maxUsers, usedCount: 0, createdAt: Date.now() });
      await logAdminAction(adminName, "Created Gift Code", code, `+${coins} Coins (Max Users: ${maxUsers})`);

      return res.status(200).json({
        status: true,
        message: `Gift Code ${code} (+${coins} Coins for ${maxUsers} users) created!`
      });
    }

    if (action === "admin_list_codes") {
      const codes = (await fbGet("giftCodes")) || {};
      const active = [];
      const expired = [];
      Object.values(codes).forEach(g => {
        if (!g || !g.code) return;
        if (Number(g.usedCount || 0) < Number(g.maxUsers || 1)) active.push(g);
        else expired.push(g);
      });
      return res.status(200).json({ status: true, activeCodes: active, expiredCodes: expired });
    }

    if (action === "admin_delete_code") {
      const code = String(params.code || "").trim().toUpperCase();
      await fbSet(`giftCodes/${code}`, null);
      await logAdminAction(adminName, "Deleted Gift Code", code, "Removed from giftCodes");

      return res.status(200).json({ status: true, message: `Gift Code ${code} deleted!` });
    }

    if (action === "admin_reset_device") {
      const targetId = String(params.target_id || "").trim();
      if (!targetId || targetId.toUpperCase() === "ALL") {
        await fbSet("deviceLocks", {});
        await fbSet("appDeviceSessions", {});
        await logAdminAction(adminName, "Reset All Device Locks", "ALL", "Cleared deviceLocks & appDeviceSessions");
        return res.status(200).json({ status: true, message: "All device locks have been reset!" });
      }

      const locks = (await fbGet("deviceLocks")) || {};
      for (const devKey in locks) {
        if (String(locks[devKey]) === targetId) {
          await fbSet(`deviceLocks/${devKey}`, null);
        }
      }
      const sessions = (await fbGet("appDeviceSessions")) || {};
      for (const sKey in sessions) {
        if (String(sessions[sKey]) === targetId) {
          await fbSet(`appDeviceSessions/${sKey}`, null);
        }
      }
      await fbUpdate(`users/${targetId}`, { deviceId: "" });
      await logAdminAction(adminName, "Reset User Device Lock", `User ${targetId}`, "Cleared bound device lock");

      return res.status(200).json({ status: true, message: `Device lock reset for User ${targetId}!` });
    }

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
              text: `📢 *SMARTU Official Announcement*\n\n${msgText}`,
              parse_mode: "Markdown"
            })
          });
          const d = await r.json();
          if (d.ok) sentCount++;
        } catch (e) {}
      }

      await logAdminAction(adminName, "Sent Broadcast", `${sentCount} Users`, msgText);

      return res.status(200).json({
        status: true,
        message: `Broadcast delivered to ${sentCount} / ${userIds.length} users!`
      });
    }

    return res.status(200).json({ status: true, message: "SMARTU Gateway Active" });
  } catch (err) {
    return res.status(500).json({ status: false, error: err.message });
  }
}

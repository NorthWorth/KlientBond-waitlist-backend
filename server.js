const dotenv = require("dotenv");
dotenv.config();

const cors = require("cors");
const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const Waitlist = require("./models/waitlist");
const {
  sendVerificationEmail
} = require("./services/emailService");


const app = express();

const PORT = process.env.PORT || 5000;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://127.0.0.1:5500";


/* =========================================================
   MIDDLEWARE
========================================================= */

const allowedOrigins = [
  FRONTEND_URL
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header.
      // Useful for local tools and health checks.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Not allowed by CORS")
      );
    }
  })
);

app.use(express.json());

/* =========================================================
   RATE LIMITERS
========================================================= */

const waitlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many requests. Please try again later."
  }
});


const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,

  message: {
    success: false,
    message: "Too many verification requests. Please try again later."
  }
});

/* =========================================================
   HELPERS
========================================================= */

function generateVerificationToken() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}


function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}


function isValidEmail(email) {
  const regex =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return regex.test(email);
}


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Rayern API is running."
  });
});


/* =========================================================
   JOIN WAITLIST
========================================================= */

app.post(
  "/api/waitlist",
  waitlistLimiter,
  async (req, res) => {

    try {
      const { email } = req.body;

      /* -------------------------
         Validate email
      ------------------------- */

      if (!email) {
        return res.status(400).json({
          success: false,
          code: "EMAIL_REQUIRED",
          message: "Email is required."
        });
      }

      const normalizedEmail =
        email.trim().toLowerCase();

      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_EMAIL",
          message:
            "Please enter a valid email address."
        });
      }


      /* -------------------------
         Find existing user
      ------------------------- */

      let waitlistUser =
        await Waitlist.findOne({
          email: normalizedEmail
        });


      /* -------------------------
         Already verified
      ------------------------- */

      if (
        waitlistUser &&
        waitlistUser.verified
      ) {
        return res.status(409).json({
          success: false,
          code: "ALREADY_VERIFIED",
          message:
            "This email is already on the Rayern waitlist."
        });
      }


      /* -------------------------
         Generate token
      ------------------------- */

      const rawToken =
        generateVerificationToken();

      const hashedToken =
        hashToken(rawToken);

      const tokenExpires =
        new Date(
          Date.now() + 30 * 60 * 1000
        );


      /* -------------------------
         Create pending user
      ------------------------- */

      if (!waitlistUser) {
        waitlistUser =
          new Waitlist({
            email: normalizedEmail,
            verified: false
          });
      }


      /* -------------------------
         Update verification data
      ------------------------- */

      waitlistUser.verificationToken =
        hashedToken;

      waitlistUser.verificationTokenExpires =
        tokenExpires;


      /* -------------------------
         Build verification URL
      ------------------------- */

      const verificationUrl =
        `${FRONTEND_URL}/landing-page/frontend/verify.html?token=${rawToken}`;


      /* -------------------------
         Send email BEFORE saving
         the new token.
      ------------------------- */

      await sendVerificationEmail(
        normalizedEmail,
        verificationUrl
      );


      /* -------------------------
         Email was successfully
         sent, so save token.
      ------------------------- */

      waitlistUser.lastVerificationSentAt =
        new Date();

      await waitlistUser.save();


      return res.status(201).json({
        success: true,
        code: "VERIFICATION_SENT",
        message:
          "Check your inbox to verify your email."
      });

    } catch (error) {

      console.error(
        "Waitlist signup error:",
        error
      );

      return res.status(500).json({
        success: false,
        code: "EMAIL_SEND_FAILED",
        message:
          "We couldn't send the verification email. Please try again."
      });
    }
  }
);


/* =========================================================
   VERIFY EMAIL
========================================================= */

app.get(
  "/api/waitlist/verify/:token",
  verificationLimiter,
  async (req, res) => {

    try {
      const { token } = req.params;


      /* -------------------------
         Validate token
      ------------------------- */

      if (!token) {
        return res.status(400).json({
          success: false,
          code: "TOKEN_REQUIRED",
          message:
            "Verification token is missing."
        });
      }


      /* -------------------------
         Hash token
      ------------------------- */

      const hashedToken =
        hashToken(token);


      /* -------------------------
         Find valid token
      ------------------------- */

      const user =
        await Waitlist.findOne({
          verificationToken: hashedToken,

          verificationTokenExpires: {
            $gt: new Date()
          }
        });


      if (!user) {
        return res.status(400).json({
          success: false,
          code: "INVALID_TOKEN",
          message:
            "This verification link is invalid or has expired."
        });
      }


      /* -------------------------
         Verify email
      ------------------------- */

      user.verified = true;

      user.verifiedAt =
        new Date();

      user.verificationToken =
        null;

      user.verificationTokenExpires =
        null;


      await user.save();


      return res.status(200).json({
        success: true,
        code: "EMAIL_VERIFIED",
        message:
          "Your email has been verified."
      });

    } catch (error) {

      console.error(
        "Verification error:",
        error
      );

      return res.status(500).json({
        success: false,
        code: "VERIFICATION_FAILED",
        message:
          "Verification failed. Please try again."
      });
    }
  }
);


/* =========================================================
   RESEND VERIFICATION
========================================================= */

app.post(
  "/api/waitlist/resend",
  verificationLimiter,
  async (req, res) => {

    try {
      const { email } = req.body;


      /* -------------------------
         Validate email
      ------------------------- */

      if (!email) {
        return res.status(400).json({
          success: false,
          code: "EMAIL_REQUIRED",
          message: "Email is required."
        });
      }


      const normalizedEmail =
        email.trim().toLowerCase();


      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_EMAIL",
          message:
            "Please enter a valid email address."
        });
      }


      /* -------------------------
         Find user
      ------------------------- */

      const user =
        await Waitlist.findOne({
          email: normalizedEmail
        });


      /*
       * Don't reveal whether an email
       * exists or is verified.
       */

      if (!user || user.verified) {
        return res.status(200).json({
          success: true,
          message:
            "If that email needs verification, a new email has been sent."
        });
      }


      /* -------------------------
         Server-side cooldown
      ------------------------- */

      if (
        user.lastVerificationSentAt &&
        Date.now() -
          user.lastVerificationSentAt.getTime() <
          30 * 1000
      ) {

        return res.status(429).json({
          success: false,
          code: "RESEND_COOLDOWN",
          message:
            "Please wait 30 seconds before requesting another email."
        });
      }


      /* -------------------------
         Generate new token
      ------------------------- */

      const rawToken =
        generateVerificationToken();

      const hashedToken =
        hashToken(rawToken);

      const tokenExpires =
        new Date(
          Date.now() + 30 * 60 * 1000
        );


      /* -------------------------
         Build verification URL
      ------------------------- */

      const verificationUrl =
        `${FRONTEND_URL}/verify.html?token=${rawToken}`;


      /* -------------------------
         Send email
      ------------------------- */

      await sendVerificationEmail(
        normalizedEmail,
        verificationUrl
      );


      /* -------------------------
         Save new token only after
         email was successfully sent.
      ------------------------- */

      user.verificationToken =
        hashedToken;

      user.verificationTokenExpires =
        tokenExpires;

      user.lastVerificationSentAt =
        new Date();


      await user.save();


      return res.status(200).json({
        success: true,
        message:
          "If that email needs verification, a new email has been sent."
      });

    } catch (error) {

      console.error(
        "Resend verification error:",
        error
      );

      return res.status(500).json({
        success: false,
        code: "RESEND_FAILED",
        message:
          "Unable to resend the verification email."
      });
    }
  }
);


/* =========================================================
   DATABASE + SERVER
========================================================= */

async function startServer() {

  try {

    await mongoose.connect(
      process.env.MONGO_URI
    );

    console.log(
      "MongoDB connected"
    );


    app.listen(
      PORT,
      () => {
        console.log(
          `Server running on port ${PORT}`
        );
      }
    );

  } catch (error) {

    console.error(
      "MongoDB connection failed:",
      error.message
    );

    process.exit(1);
  }
}


startServer();
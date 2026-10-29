const mongoose = require("mongoose");

const waitlistSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },

    verified: {
      type: Boolean,
      default: false
    },

    verificationToken: {
      type: String,
      default: null
    },

    verificationTokenExpires: {
      type: Date,
      default: null
    },

    verifiedAt: {
      type: Date,
      default: null
    },

    lastVerificationSentAt: {
      type: Date,
      default: null
    },

    joinedAt: {
      type: Date,
      default: Date.now
    },

    /* -------------------------------------------------------
       Marketing (promotional) email consent.

       Email VERIFICATION is NOT marketing consent — verifying
       an address never touches this sub-document.

       optedIn      defaults to FALSE. Existing records created
                    before this field existed read as
                    { optedIn: false } (non-consented), never as
                    opted in.
       consentedAt  timestamp of the most recent AFFIRMATIVE
                    opt-in; kept as history after an opt-out.
       updatedAt    timestamp of the most recent consent change
                    (either direction); null while unchanged.
       source       where the current preference was set:
                    "waitlist_form" (checkbox on the join form) or
                    "preference_api" (the explicit opt-out endpoint).
       ------------------------------------------------------- */
    marketingConsent: {
      optedIn: {
        type: Boolean,
        default: false,
        index: true
      },
      consentedAt: {
        type: Date,
        default: null
      },
      updatedAt: {
        type: Date,
        default: null
      },
      source: {
        type: String,
        enum: [null, "waitlist_form", "preference_api"],
        default: null
      }
    }
  },

  {
    timestamps: true
  }
);

/* Admin list ordering: newest first with a stable tie-breaker so
   pagination never skips or repeats rows with identical joinedAt. */
waitlistSchema.index({ joinedAt: -1, _id: -1 });

module.exports =
  mongoose.model(
    "Waitlist",
    waitlistSchema
  );
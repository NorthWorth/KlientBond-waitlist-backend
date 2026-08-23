const { Resend } = require("resend");

const resend =
  new Resend(process.env.RESEND_API_KEY);


async function sendVerificationEmail(
  email,
  verificationUrl
) {

  const { data, error } =
    await resend.emails.send({

      from:
        process.env.FROM_EMAIL,

      to: [email],

      subject:
        "Verify your Rayern email",

      html: `
        <!DOCTYPE html>

        <html lang="en">

        <head>

          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          >

          <title>
            Verify your Rayern email
          </title>

        </head>


        <body
          style="
            margin:0;
            padding:0;
            background:#f7f7fa;
            font-family:
              Arial,
              Helvetica,
              sans-serif;
          "
        >

          <div
            style="
              max-width:560px;
              margin:40px auto;
              padding:20px;
            "
          >

            <div
              style="
                background:#ffffff;
                border:1px solid #e8e8ed;
                border-radius:20px;
                padding:36px 28px;
              "
            >

              <div
                style="
                  font-size:22px;
                  font-weight:700;
                  color:#101114;
                  margin-bottom:30px;
                "
              >
                Rayern
              </div>


              <h1
                style="
                  margin:0 0 14px;
                  font-size:28px;
                  line-height:1.2;
                  color:#101114;
                "
              >
                Verify your email
              </h1>


              <p
                style="
                  margin:0 0 26px;
                  color:#667085;
                  font-size:15px;
                  line-height:1.7;
                "
              >
                You're almost on the
                Rayern waitlist.
                Confirm your email address
                to complete your signup.
              </p>


              <a
                href="${verificationUrl}"
                style="
                  display:inline-block;
                  padding:14px 22px;
                  background:#6d5ef8;
                  color:#ffffff;
                  text-decoration:none;
                  border-radius:10px;
                  font-size:14px;
                  font-weight:700;
                "
              >
                Verify my email
              </a>


              <p
                style="
                  margin:28px 0 0;
                  color:#98a0ad;
                  font-size:12px;
                  line-height:1.6;
                "
              >
                This verification link expires
                in 30 minutes.
              </p>

            </div>


            <p
              style="
                text-align:center;
                color:#98a0ad;
                font-size:11px;
                margin-top:20px;
              "
            >
              You're receiving this email because
              someone entered this address on
              Rayern.
            </p>

          </div>

        </body>

        </html>
      `
    });


  if (error) {
    throw new Error(
      error.message
    );
  }


  return data;
}


module.exports = {
  sendVerificationEmail
};
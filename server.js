import express from "express";

const app = express();

const App_Name = process.env.APP_NAME;

app.get("/", (req, res) => {
  res.send(`<h1>Hello, ${App_Name}!</h1>`);
});

app.listen(3000, () => {
  console.log(`${App_Name} is running on port 3000`);
});

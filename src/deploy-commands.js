"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
var discord_js_1 = require("discord.js");
var token = process.env.DISCORD_TOKEN;
var clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in the environment variables.');
}
var commands = [
    new discord_js_1.SlashCommandBuilder()
        .setName('ask')
        .setDescription('ask from Alfe')
        .addStringOption(function (option) {
        return option.setName('prompt')
            .setRequired(true);
    })
        .toJSON()
];
var rest = new discord_js_1.REST({ version: '10' }).setToken(token);
await rest.put(discord_js_1.Routes.applicationCommands(clientId), {
    body: commands
});

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

const app = express();
const PORT = process.env.PORT || 3001;

// Environment variables
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BUMP_CHANNEL_ID = process.env.BUMP_CHANNEL_ID;
const CONSOLE_CHANNEL_ID = process.env.CONSOLE_CHANNEL_ID;
const NOCODB_BASE_URL = process.env.NOCODB_BASE_URL; // e.g., https://app.nocodb.com
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const NOCODB_TABLE_ID = process.env.NOCODB_TABLE_ID;
const NOCODB_WORKSPACE_ID = process.env.NOCODB_WORKSPACE_ID;
const NOCODB_BASE_ID = process.env.NOCODB_BASE_ID;

// NocoDB API configuration
const nocodbConfig = {
    headers: {
        'xc-token': NOCODB_API_TOKEN,
        'Content-Type': 'application/json'
    }
};

client.once('ready', async () => {
    console.log(`✅ Minecraft Tracker Bot is online as ${client.user.tag}`);
    console.log(`📡 Monitoring bump channel: ${BUMP_CHANNEL_ID}`);
    console.log(`🖥️ Console channel: ${CONSOLE_CHANNEL_ID}`);
    console.log(`🗄️ NocoDB configured: ${NOCODB_BASE_URL ? 'Yes' : 'No'}`);
});

// Listen for bump commands
client.on('interactionCreate', async (interaction) => {
    if (interaction.channel.id !== BUMP_CHANNEL_ID) return;
    
    if (interaction.isCommand() && interaction.commandName === 'bump') {
        await handleBumpDetection(interaction.user);
    }
    
    if (interaction.isModalSubmit() && interaction.customId === 'minecraft_username_modal') {
        await handleMinecraftUsernameSubmission(interaction);
    }
});

// Listen for bump bot responses to detect who bumped
client.on('messageCreate', async (message) => {
    if (message.channel.id !== BUMP_CHANNEL_ID) return;
    
    // Handle user commands (non-bot messages starting with !)
    if (!message.author.bot && message.content.startsWith('!')) {
        return handleUserCommands(message);
    }
    
    // Handle bot messages for bump detection
    if (message.author.bot) {
        await detectBumpBotResponse(message);
    }
});

async function detectBumpBotResponse(message) {
    const knownBumpBots = [
        '302050872383242240', // Disboard
        '716390085896962058', // Bump.ly
        '450100127256936458', // ServerHound
        '1382299188095746088'  // Another bump bot
    ];
    
    const bumpBotPatterns = [
        /bump done|bumped|bump successful/i,
        /server bumped/i,
        /bump complete/i,
        /successfully bumped/i
    ];

    if (knownBumpBots.includes(message.author.id)) {
        const content = message.content || '';
        let isMatch = bumpBotPatterns.some(pattern => pattern.test(content));

        // Check embeds for bump confirmation
        let embedText = '';
        if (message.embeds.length) {
            for (const embed of message.embeds) {
                embedText += `${embed.title || ''} ${embed.description || ''} `;
            }
        }
        isMatch = isMatch || bumpBotPatterns.some(p => p.test(embedText));

        if (isMatch) {
            console.log(`🚀 Detected bump from bot: ${message.author.tag}`);
            
            // Try to find who triggered the bump by looking at recent messages
            const recentMessages = await message.channel.messages.fetch({ limit: 10 });
            let bumpUser = null;
            
            // Look for slash command interactions or messages that might indicate who bumped
            for (const msg of recentMessages.values()) {
                if (msg.interaction && msg.interaction.commandName === 'bump') {
                    bumpUser = msg.interaction.user;
                    break;
                }
            }
            
            if (bumpUser) {
                await handleBumpDetection(bumpUser);
            }
        }
    }
}

async function handleBumpDetection(user) {
    try {
        console.log(`👤 Processing bump from user: ${user.tag} (${user.id})`);
        
        // Check if user exists in NocoDB
        const userRecord = await getUserFromNocoDB(user.id);
        
        if (userRecord && userRecord.minecraft_username) {
            // User exists with Minecraft username
            await sendBumpRewardMessage(user, userRecord.minecraft_username);
            await sendConsoleCommand(userRecord.minecraft_username);
        } else {
            // User doesn't exist or doesn't have Minecraft username
            await promptForMinecraftUsername(user);
        }
    } catch (error) {
        console.error('Error handling bump detection:', error);
    }
}

async function getUserFromNocoDB(discordId) {
    try {
        const response = await axios.get(
            `${NOCODB_BASE_URL}/api/v2/tables/${NOCODB_TABLE_ID}/records`,
            {
                ...nocodbConfig,
                params: {
                    where: `(discord_id,eq,${discordId})`
                }
            }
        );
        
        if (response.data && response.data.list && response.data.list.length > 0) {
            return response.data.list[0];
        }
        return null;
    } catch (error) {
        console.error('Error fetching user from NocoDB:', error);
        return null;
    }
}

async function addUserToNocoDB(discordId, discordUsername, minecraftUsername) {
    try {
        const response = await axios.post(
            `${NOCODB_BASE_URL}/api/v2/tables/${NOCODB_TABLE_ID}/records`,
            {
                discord_id: discordId,
                discord_username: discordUsername,
                minecraft_username: minecraftUsername,
                created_at: new Date().toISOString()
            },
            nocodbConfig
        );
        
        return response.data;
    } catch (error) {
        console.error('Error adding user to NocoDB:', error);
        throw error;
    }
}

async function updateUserInNocoDB(recordId, minecraftUsername) {
    try {
        const response = await axios.patch(
            `${NOCODB_BASE_URL}/api/v2/tables/${NOCODB_TABLE_ID}/records/${recordId}`,
            {
                minecraft_username: minecraftUsername,
                updated_at: new Date().toISOString()
            },
            nocodbConfig
        );
        
        return response.data;
    } catch (error) {
        console.error('Error updating user in NocoDB:', error);
        throw error;
    }
}

async function sendBumpRewardMessage(user, minecraftUsername) {
    try {
        const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
        if (!bumpChannel) {
            console.error('Bump channel not found');
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🎮 Bump Detected - User Found!')
            .setDescription(`User ${user.tag} has bumped the server`)
            .addFields(
                { name: '👤 Discord User', value: `${user.tag} (${user.id})`, inline: true },
                { name: '🎯 Minecraft Username', value: minecraftUsername, inline: true },
                { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            )
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .setTimestamp()
            .setFooter({ text: 'Minecraft Tracker Bot' });
        
        await bumpChannel.send({ content: `${user} Your reward has been sent! 🎁`, embeds: [embed] });
        console.log(`✅ Sent bump reward message for ${user.tag} with Minecraft username: ${minecraftUsername}`);
    } catch (error) {
        console.error('Error sending bump reward message:', error);
    }
}

async function sendConsoleCommand(minecraftUsername) {
    try {
        const consoleChannel = client.channels.cache.get(CONSOLE_CHANNEL_ID);
        if (!consoleChannel) {
            console.error('Console channel not found');
            return;
        }
        
        const command = `eco give ${minecraftUsername} 10`;
        await consoleChannel.send(command);
        console.log(`💰 Sent console command: ${command}`);
    } catch (error) {
        console.error('Error sending console command:', error);
    }
}

async function promptForMinecraftUsername(user) {
    try {
        const modal = new ModalBuilder()
            .setCustomId('minecraft_username_modal')
            .setTitle('Minecraft Username Required');

        const minecraftUsernameInput = new TextInputBuilder()
            .setCustomId('minecraft_username_input')
            .setLabel('Enter your Minecraft username')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Steve, Notch, your_username')
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(16);

        const actionRow = new ActionRowBuilder().addComponents(minecraftUsernameInput);
        modal.addComponents(actionRow);
        
        // Send a DM to the user with the modal
        try {
            await user.send({
                content: '🎮 **Minecraft Username Required**\n\nYou\'ve bumped the server but we need your Minecraft username! Please fill out the form below:',
                components: [
                    new ActionRowBuilder().addComponents(
                        // Note: Modals can't be sent directly in DMs, so we'll send instructions
                    )
                ]
            });
        } catch (dmError) {
            console.log('Could not send DM to user, they may have DMs disabled');
        }
        
        // Also send a message in the bump channel
        const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
        if (bumpChannel) {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('🎮 Minecraft Username Required')
                .setDescription(`${user}, thanks for bumping! We need your Minecraft username to track your contribution.`)
                .addFields(
                    { name: '📝 Next Steps', value: 'Please use the `/minecraft` command to set your username' },
                    { name: '❓ Why?', value: 'This helps us track server bumps and reward active members' }
                )
                .setTimestamp()
                .setFooter({ text: 'Use /minecraft <username> to set your username' });
            
            await bumpChannel.send({ content: `${user}`, embeds: [embed] });
        }
        
        console.log(`❓ Prompted ${user.tag} for Minecraft username`);
    } catch (error) {
        console.error('Error prompting for Minecraft username:', error);
    }
}

async function handleMinecraftUsernameSubmission(interaction) {
    try {
        const minecraftUsername = interaction.fields.getTextInputValue('minecraft_username_input');
        const user = interaction.user;
        
        // Validate Minecraft username (basic validation)
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(minecraftUsername)) {
            await interaction.reply({
                content: '❌ Invalid Minecraft username! It should be 3-16 characters long and contain only letters, numbers, and underscores.',
                ephemeral: true
            });
            return;
        }
        
        // Check if user already exists in database
        const existingUser = await getUserFromNocoDB(user.id);
        
        if (existingUser) {
            // Update existing user
            await updateUserInNocoDB(existingUser.Id, minecraftUsername);
        } else {
            // Add new user
            await addUserToNocoDB(user.id, user.tag, minecraftUsername);
        }
        
        // Send success message
        await interaction.reply({
            content: `✅ Successfully saved your Minecraft username: **${minecraftUsername}**\n\nNext time you bump, we'll automatically track it!`,
            ephemeral: true
        });
        
        // Send bump reward message and console command
        await sendBumpRewardMessage(user, minecraftUsername);
        await sendConsoleCommand(minecraftUsername);
        
        console.log(`✅ Added/Updated Minecraft username for ${user.tag}: ${minecraftUsername}`);
    } catch (error) {
        console.error('Error handling Minecraft username submission:', error);
        await interaction.reply({
            content: '❌ An error occurred while saving your username. Please try again later.',
            ephemeral: true
        });
    }
}

async function handleUserCommands(message) {
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    if (command === 'minecraft') {
        await handleMinecraftCommand(message, args);
    }
}

async function handleMinecraftCommand(message, args) {
    try {
        if (args.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('❌ Missing Username')
                .setDescription('Please provide your Minecraft username!')
                .addFields(
                    { name: '📝 Usage', value: '`!minecraft <username>`' },
                    { name: '📖 Example', value: '`!minecraft Steve123`' }
                )
                .setTimestamp();
            
            return message.reply({ embeds: [embed] });
        }
        
        const minecraftUsername = args[0];
        
        // Validate Minecraft username
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(minecraftUsername)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Invalid Username')
                .setDescription('Minecraft usernames must be 3-16 characters long and contain only letters, numbers, and underscores.')
                .addFields(
                    { name: '📝 Valid Examples', value: '`Steve`, `Notch`, `Player123`, `Cool_Gamer`' },
                    { name: '❌ Invalid Examples', value: '`AB`, `ThisNameIsTooLong123`, `Player-123`, `User@123`' }
                )
                .setTimestamp();
            
            return message.reply({ embeds: [embed] });
        }
        
        // Check if user already exists in database
        const existingUser = await getUserFromNocoDB(message.author.id);
        
        if (existingUser) {
            // Update existing user
            await updateUserInNocoDB(existingUser.Id, minecraftUsername);
        } else {
            // Add new user
            await addUserToNocoDB(message.author.id, message.author.tag, minecraftUsername);
        }
        
        // Send success message
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ Success!')
            .setDescription(`Successfully saved your Minecraft username: **${minecraftUsername}**`)
            .addFields(
                { name: '🎮 Username Set', value: minecraftUsername, inline: true },
                { name: '👤 Discord User', value: message.author.tag, inline: true },
                { name: '📝 Next Step', value: 'Bump the server to get your rewards!' }
            )
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
            .setTimestamp()
            .setFooter({ text: 'Minecraft Tracker Bot' });
        
        await message.reply({ embeds: [embed] });
        
        console.log(`✅ User ${message.author.tag} set Minecraft username via !minecraft: ${minecraftUsername}`);
    } catch (error) {
        console.error('Error handling !minecraft command:', error);
        
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Error')
            .setDescription('An error occurred while saving your username. Please try again later.')
            .setTimestamp();
        
        await message.reply({ embeds: [embed] });
    }
}

// Health check endpoints
app.get('/', (req, res) => {
    res.json({ 
        status: 'Minecraft Tracker Bot is running!', 
        uptime: process.uptime(), 
        timestamp: new Date().toISOString(),
        bot_status: client.user ? 'connected' : 'disconnected'
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        bot: client.user ? 'connected' : 'disconnected', 
        guilds: client.guilds.cache.size,
        nocodb_configured: !!NOCODB_BASE_URL
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Login to Discord
client.login(DISCORD_BOT_TOKEN).catch(console.error);

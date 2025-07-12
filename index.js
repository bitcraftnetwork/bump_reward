const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// Initialize Express app first for health checks
const app = express();
const PORT = process.env.PORT || 10000; // Render uses port 10000

// Middleware
app.use(express.json());

// Environment variables
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BUMP_CHANNEL_ID = process.env.BUMP_CHANNEL_ID;
const CONSOLE_CHANNEL_ID = process.env.CONSOLE_CHANNEL_ID;
const NOCODB_BASE_URL = process.env.NOCODB_BASE_URL;
const NOCODB_API_TOKEN = process.env.NOCODB_API_TOKEN;
const NOCODB_TABLE_ID = process.env.NOCODB_TABLE_ID;
const NOCODB_WORKSPACE_ID = process.env.NOCODB_WORKSPACE_ID;
const NOCODB_BASE_ID = process.env.NOCODB_BASE_ID;
const BUMP_ROLE_ID = process.env.BUMP_ROLE_ID || '1382278107024851005';

// Hidden users configuration - Discord user IDs whose Minecraft usernames should be hidden
const HIDDEN_USERS = [
    // Add Discord user IDs here whose Minecraft usernames should be hidden from public messages
    851409275010940948,
    710833692490203156,
    680123642557759539,
    466884574081843202
];

// In-memory storage for pending role assignments (will reset on restart)
const pendingRoleAssignments = new Map();

// NocoDB API configuration
const nocodbConfig = {
    headers: {
        'xc-token': NOCODB_API_TOKEN,
        'Content-Type': 'application/json'
    }
};

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers
    ]
});

// Health check endpoints (important for Render)
app.get('/', (req, res) => {
    res.json({ 
        status: 'Minecraft Tracker Bot is running!', 
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        bot_status: client.user ? 'connected' : 'disconnected',
        memory_usage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        bot: client.user ? 'connected' : 'disconnected', 
        guilds: client.guilds.cache.size,
        nocodb_configured: !!NOCODB_BASE_URL,
        uptime: Math.floor(process.uptime())
    });
});

// Keep-alive endpoint for external monitoring
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Discord bot event handlers
client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    console.log(`📡 Bump channel: ${BUMP_CHANNEL_ID}`);
    console.log(`🖥️ Console channel: ${CONSOLE_CHANNEL_ID}`);
    console.log(`🗄️ NocoDB: ${NOCODB_BASE_URL ? 'Configured' : 'Not configured'}`);
    console.log(`🎭 Bump role: ${BUMP_ROLE_ID}`);
    console.log(`🔒 Hidden users: ${HIDDEN_USERS.length}`);
    
    // Set bot status
    client.user.setPresence({
        activities: [{ name: 'for server bumps!', type: 'WATCHING' }],
        status: 'online'
    });
});

// Handle interactions
client.on('interactionCreate', async (interaction) => {
    if (interaction.channel.id !== BUMP_CHANNEL_ID) return;
    
    try {
        if (interaction.isCommand() && interaction.commandName === 'bump') {
            await handleBumpDetection(interaction.user);
        }
        
        if (interaction.isButton()) {
            if (interaction.customId === 'confirm_role_assignment') {
                await handleRoleConfirmation(interaction, true);
            } else if (interaction.customId === 'decline_role_assignment') {
                await handleRoleConfirmation(interaction, false);
            }
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
    }
});

// Handle messages
client.on('messageCreate', async (message) => {
    if (message.channel.id !== BUMP_CHANNEL_ID) return;
    
    try {
        if (!message.author.bot && message.content.startsWith('!')) {
            return handleUserCommands(message);
        }
        
        if (message.author.bot) {
            await detectBumpBotResponse(message);
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
});

// Bump detection functions
async function detectBumpBotResponse(message) {
    const knownBumpBots = [
        '302050872383242240', // Disboard
        '716390085896962058', // Bump.ly
        '450100127256936458', // ServerHound
        '1382299188095746088'
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

        let embedText = '';
        if (message.embeds.length) {
            for (const embed of message.embeds) {
                embedText += `${embed.title || ''} ${embed.description || ''} `;
            }
        }
        isMatch = isMatch || bumpBotPatterns.some(p => p.test(embedText));

        if (isMatch) {
            console.log(`🚀 Bump detected from: ${message.author.tag}`);
            
            const recentMessages = await message.channel.messages.fetch({ limit: 10 });
            let bumpUser = null;
            
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
        console.log(`👤 Processing bump: ${user.tag}`);
        
        const userRecord = await getUserFromNocoDB(user.id);
        
        if (userRecord && userRecord.minecraft_username) {
            const isHiddenUser = HIDDEN_USERS.includes(user.id);
            await sendBumpRewardMessage(user, userRecord.minecraft_username, isHiddenUser);
            await sendConsoleCommand(userRecord.minecraft_username);
        } else {
            await promptForMinecraftUsername(user);
        }
    } catch (error) {
        console.error('Error handling bump:', error);
    }
}

// NocoDB functions with timeout and retry logic
async function getUserFromNocoDB(discordId) {
    try {
        const response = await axios.get(
            `${NOCODB_BASE_URL}/api/v2/tables/${NOCODB_TABLE_ID}/records`,
            {
                ...nocodbConfig,
                params: { where: `(discord_id,eq,${discordId})` },
                timeout: 10000 // 10 second timeout
            }
        );
        
        if (response.data?.list?.length > 0) {
            return response.data.list[0];
        }
        return null;
    } catch (error) {
        console.error('Error fetching user from NocoDB:', error.message);
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
            {
                ...nocodbConfig,
                timeout: 10000
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('Error adding user to NocoDB:', error.message);
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
            {
                ...nocodbConfig,
                timeout: 10000
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('Error updating user in NocoDB:', error.message);
        throw error;
    }
}

// Role management functions
async function assignBumpRole(user, guild) {
    try {
        const member = await guild.members.fetch(user.id);
        const role = guild.roles.cache.get(BUMP_ROLE_ID);
        
        if (!role) {
            console.error(`❌ Role not found: ${BUMP_ROLE_ID}`);
            return false;
        }
        
        if (member.roles.cache.has(BUMP_ROLE_ID)) {
            console.log(`👤 ${user.tag} already has role`);
            return true;
        }
        
        await member.roles.add(role);
        console.log(`✅ Role assigned to ${user.tag}`);
        return true;
    } catch (error) {
        console.error(`❌ Error assigning role:`, error.message);
        return false;
    }
}

async function requestRoleAssignmentConfirmation(user, guild, minecraftUsername) {
    try {
        const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
        if (!bumpChannel) return;
        
        const member = await guild.members.fetch(user.id);
        if (member.roles.cache.has(BUMP_ROLE_ID)) {
            console.log(`👤 ${user.tag} already has role`);
            return;
        }
        
        const confirmButton = new ButtonBuilder()
            .setCustomId('confirm_role_assignment')
            .setLabel('Yes, assign role')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');
        
        const declineButton = new ButtonBuilder()
            .setCustomId('decline_role_assignment')
            .setLabel('No, skip role')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('❌');
        
        const row = new ActionRowBuilder().addComponents(confirmButton, declineButton);
        
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('🎭 Role Assignment')
            .setDescription(`${user}, would you like the **Bump Role**?`)
            .addFields(
                { name: '🎯 Benefits', value: 'Get notified about server events!' },
                { name: '⏱️ Time Limit', value: '2 minutes to respond' }
            )
            .setTimestamp();
        
        const message = await bumpChannel.send({ 
            content: `${user}`,
            embeds: [embed], 
            components: [row] 
        });
        
        // Store with timeout
        const timeoutId = setTimeout(async () => {
            await handleRoleTimeout(user.id, message, minecraftUsername);
        }, 120000);
        
        pendingRoleAssignments.set(user.id, {
            guild: guild,
            minecraftUsername: minecraftUsername,
            message: message,
            timeoutId: timeoutId
        });
        
    } catch (error) {
        console.error('Error requesting role confirmation:', error);
    }
}

async function handleRoleConfirmation(interaction, confirmed) {
    try {
        const userId = interaction.user.id;
        const pendingAssignment = pendingRoleAssignments.get(userId);
        
        if (!pendingAssignment) {
            await interaction.reply({
                content: '❌ No pending assignment found.',
                ephemeral: true
            });
            return;
        }
        
        clearTimeout(pendingAssignment.timeoutId);
        pendingRoleAssignments.delete(userId);
        
        if (confirmed) {
            const roleAssigned = await assignBumpRole(interaction.user, pendingAssignment.guild);
            
            if (roleAssigned) {
                const embed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('✅ Role Assigned!')
                    .setDescription(`Welcome to the bump team, ${interaction.user}! 🎉`)
                    .setTimestamp();
                
                await interaction.update({ embeds: [embed], components: [] });
                
                const isHiddenUser = HIDDEN_USERS.includes(interaction.user.id);
                await sendBumpRewardMessage(interaction.user, pendingAssignment.minecraftUsername, isHiddenUser);
                await sendConsoleCommand(pendingAssignment.minecraftUsername);
                
                setTimeout(() => interaction.message.delete().catch(() => {}), 10000);
            } else {
                await interaction.update({
                    content: '❌ Failed to assign role.',
                    embeds: [],
                    components: []
                });
            }
        } else {
            const embed = new EmbedBuilder()
                .setColor('#808080')
                .setTitle('👋 Role Declined')
                .setDescription(`No problem, ${interaction.user}!`)
                .setTimestamp();
            
            await interaction.update({ embeds: [embed], components: [] });
            
            const isHiddenUser = HIDDEN_USERS.includes(interaction.user.id);
            await sendBumpRewardMessage(interaction.user, pendingAssignment.minecraftUsername, isHiddenUser);
            await sendConsoleCommand(pendingAssignment.minecraftUsername);
            
            setTimeout(() => interaction.message.delete().catch(() => {}), 10000);
        }
        
    } catch (error) {
        console.error('Error handling role confirmation:', error);
    }
}

async function handleRoleTimeout(userId, message, minecraftUsername) {
    try {
        const pendingAssignment = pendingRoleAssignments.get(userId);
        if (!pendingAssignment) return;
        
        pendingRoleAssignments.delete(userId);
        
        const embed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle('⏰ Timed Out')
            .setDescription('No response received. Role skipped.')
            .setTimestamp();
        
        await message.edit({ embeds: [embed], components: [] });
        
        const user = await client.users.fetch(userId);
        const isHiddenUser = HIDDEN_USERS.includes(userId);
        await sendBumpRewardMessage(user, minecraftUsername, isHiddenUser);
        await sendConsoleCommand(minecraftUsername);
        
        setTimeout(() => message.delete().catch(() => {}), 10000);
        
    } catch (error) {
        console.error('Error handling timeout:', error);
    }
}

// Message functions
async function sendBumpRewardMessage(user, minecraftUsername, isHiddenUser = false) {
    try {
        const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
        if (!bumpChannel) return;
        
        const displayUsername = isHiddenUser ? '***Hidden***' : minecraftUsername;
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('🎮 Bump Detected - Reward Sent!')
            .setDescription(`${user} bumped the server! 🎁`)
            .addFields(
                { name: '🎯 Minecraft Username', value: displayUsername, inline: true },
                { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                { name: '💰 Rewards', value: '• 1x Balanced Crate Key\n• 3 minutes Temp Fly', inline: false }
            )
            .setTimestamp();
        
        await bumpChannel.send({ embeds: [embed] });
        console.log(`✅ Reward message sent for ${user.tag}`);
    } catch (error) {
        console.error('Error sending reward message:', error);
    }
}

async function sendConsoleCommand(minecraftUsername) {
    try {
        const consoleChannel = client.channels.cache.get(CONSOLE_CHANNEL_ID);
        if (!consoleChannel) return;
        
        const command1 = `crate key give ${minecraftUsername} balanced 1 offline`;
        const command2 = `tempfly give ${minecraftUsername} 3m`;
        
        await consoleChannel.send(command1);
        await consoleChannel.send(command2);
        console.log(`💰 Console commands sent for ${minecraftUsername}`);
    } catch (error) {
        console.error('Error sending console commands:', error);
    }
}

async function promptForMinecraftUsername(user) {
    try {
        const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
        if (!bumpChannel) return;
        
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('🎮 Minecraft Username Required')
            .setDescription(`${user}, thanks for bumping! Set your Minecraft username.`)
            .addFields(
                { name: '📝 Command', value: '`!minecraft <username>`' },
                { name: '📖 Example', value: '`!minecraft Steve123`' }
            )
            .setTimestamp();
        
        const message = await bumpChannel.send({ content: `${user}`, embeds: [embed] });
        setTimeout(() => message.delete().catch(() => {}), 120000);
        
    } catch (error) {
        console.error('Error prompting for username:', error);
    }
}

// User commands
async function handleUserCommands(message) {
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    if (command === 'minecraft') {
        await handleMinecraftCommand(message, args);
    }
}

async function handleMinecraftCommand(message, args) {
    try {
        message.delete().catch(() => {});
        
        if (args.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('❌ Missing Username')
                .setDescription(`${message.author}, provide your Minecraft username!`)
                .addFields({ name: '📝 Usage', value: '`!minecraft <username>`' })
                .setTimestamp();
            
            const reply = await message.channel.send({ embeds: [embed] });
            setTimeout(() => reply.delete().catch(() => {}), 30000);
            return;
        }
        
        const minecraftUsername = args[0];
        
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(minecraftUsername)) {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('❌ Invalid Username')
                .setDescription(`${message.author}, username must be 3-16 characters (letters, numbers, underscores only).`)
                .setTimestamp();
            
            const reply = await message.channel.send({ embeds: [embed] });
            setTimeout(() => reply.delete().catch(() => {}), 30000);
            return;
        }
        
        const existingUser = await getUserFromNocoDB(message.author.id);
        let isUpdate = false;
        
        if (existingUser) {
            await updateUserInNocoDB(existingUser.Id, minecraftUsername);
            isUpdate = true;
        } else {
            await addUserToNocoDB(message.author.id, message.author.tag, minecraftUsername);
        }
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle(isUpdate ? '✅ Username Updated!' : '✅ Registration Successful!')
            .setDescription(`${message.author}, username ${isUpdate ? 'updated' : 'registered'}: **${minecraftUsername}**`)
            .setTimestamp();
        
        const reply = await message.channel.send({ embeds: [embed] });
        setTimeout(() => reply.delete().catch(() => {}), 60000);
        
        if (!isUpdate || !await checkUserHasRole(message.author, message.guild)) {
            await requestRoleAssignmentConfirmation(message.author, message.guild, minecraftUsername);
        }
        
        console.log(`✅ ${message.author.tag} ${isUpdate ? 'updated' : 'set'} username: ${minecraftUsername}`);
        
    } catch (error) {
        console.error('Error handling minecraft command:', error);
        
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Error')
            .setDescription(`${message.author}, error occurred. Try again later.`)
            .setTimestamp();
        
        const reply = await message.channel.send({ embeds: [embed] });
        setTimeout(() => reply.delete().catch(() => {}), 30000);
    }
}

async function checkUserHasRole(user, guild) {
    try {
        const member = await guild.members.fetch(user.id);
        return member.roles.cache.has(BUMP_ROLE_ID);
    } catch (error) {
        console.error('Error checking user role:', error);
        return false;
    }
}

// Start the server
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

// Error handling
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

client.on('disconnect', () => {
    console.log('❌ Bot disconnected');
});

client.on('reconnecting', () => {
    console.log('🔄 Bot reconnecting');
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    client.destroy();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    client.destroy();
    process.exit(0);
});

// Login to Discord
if (!DISCORD_BOT_TOKEN) {
    console.error('❌ DISCORD_BOT_TOKEN is required');
    process.exit(1);
}

client.login(DISCORD_BOT_TOKEN).catch((error) => {
    console.error('❌ Failed to login:', error);
    process.exit(1);
});

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require(‘discord.js’);
const express = require(‘express’);
const axios = require(‘axios’);
require(‘dotenv’).config();

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
GatewayIntentBits.GuildMessageReactions,
GatewayIntentBits.GuildMembers // Added for role management
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

// Role configuration
const BUMP_ROLE_ID = ‘1382278107024851005’; // The role ID to assign

// Store pending role assignments with timeout
const pendingRoleAssignments = new Map();

// Hidden users configuration - Discord user IDs whose Minecraft usernames should be hidden
const HIDDEN_USERS = [
“123456789012345678”, // Replace with actual Discord user IDs
“987654321098765432”, // Add more user IDs as needed
“111222333444555666”  // These users’ Minecraft usernames will be hidden from public messages
];

// NocoDB API configuration
const nocodbConfig = {
headers: {
‘xc-token’: NOCODB_API_TOKEN,
‘Content-Type’: ‘application/json’
}
};

client.once(‘ready’, async () => {
console.log(`✅ Minecraft Tracker Bot is online as ${client.user.tag}`);
console.log(`📡 Monitoring bump channel: ${BUMP_CHANNEL_ID}`);
console.log(`🖥️ Console channel: ${CONSOLE_CHANNEL_ID}`);
console.log(`🗄️ NocoDB configured: ${NOCODB_BASE_URL ? 'Yes' : 'No'}`);
console.log(`🎭 Bump role ID: ${BUMP_ROLE_ID}`);
console.log(`🔒 Hidden users count: ${HIDDEN_USERS.length}`);
});

// Listen for bump commands
client.on(‘interactionCreate’, async (interaction) => {
if (interaction.channel.id !== BUMP_CHANNEL_ID) return;

```
if (interaction.isCommand() && interaction.commandName === 'bump') {
    await handleBumpDetection(interaction.user);
}

if (interaction.isModalSubmit() && interaction.customId === 'minecraft_username_modal') {
    await handleMinecraftUsernameSubmission(interaction);
}

// Handle role assignment confirmation buttons
if (interaction.isButton()) {
    if (interaction.customId === 'confirm_role_assignment') {
        await handleRoleConfirmation(interaction, true);
    } else if (interaction.customId === 'decline_role_assignment') {
        await handleRoleConfirmation(interaction, false);
    }
}
```

});

// Listen for bump bot responses to detect who bumped
client.on(‘messageCreate’, async (message) => {
if (message.channel.id !== BUMP_CHANNEL_ID) return;

```
// Handle user commands (non-bot messages starting with !)
if (!message.author.bot && message.content.startsWith('!')) {
    return handleUserCommands(message);
}

// Handle bot messages for bump detection
if (message.author.bot) {
    await detectBumpBotResponse(message);
}
```

});

async function detectBumpBotResponse(message) {
const knownBumpBots = [
‘302050872383242240’, // Disboard
‘716390085896962058’, // Bump.ly
‘450100127256936458’, // ServerHound
‘1382299188095746088’  // Another bump bot
];

```
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
```

}

async function handleBumpDetection(user) {
try {
console.log(`👤 Processing bump from user: ${user.tag} (${user.id})`);

```
    // Check if user exists in NocoDB
    const userRecord = await getUserFromNocoDB(user.id);
    
    if (userRecord && userRecord.minecraft_username) {
        // User exists with Minecraft username
        const isHiddenUser = HIDDEN_USERS.includes(user.id);
        await sendBumpRewardMessage(user, userRecord.minecraft_username, isHiddenUser);
        await sendConsoleCommand(userRecord.minecraft_username);
    } else {
        // User doesn't exist or doesn't have Minecraft username
        await promptForMinecraftUsername(user);
    }
} catch (error) {
    console.error('Error handling bump detection:', error);
}
```

}

async function getUserFromNocoDB(discordId) {
try {
const response = await axios.get(
`${NOCODB_BASE_URL}/api/v2/tables/${NOCODB_TABLE_ID}/records`,
{
…nocodbConfig,
params: {
where: `(discord_id,eq,${discordId})`
}
}
);

```
    if (response.data && response.data.list && response.data.list.length > 0) {
        return response.data.list[0];
    }
    return null;
} catch (error) {
    console.error('Error fetching user from NocoDB:', error);
    return null;
}
```

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

```
    return response.data;
} catch (error) {
    console.error('Error adding user to NocoDB:', error);
    throw error;
}
```

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

```
    return response.data;
} catch (error) {
    console.error('Error updating user in NocoDB:', error);
    throw error;
}
```

}

async function assignBumpRole(user, guild) {
try {
const member = await guild.members.fetch(user.id);
const role = guild.roles.cache.get(BUMP_ROLE_ID);

```
    if (!role) {
        console.error(`❌ Bump role not found: ${BUMP_ROLE_ID}`);
        return false;
    }
    
    if (member.roles.cache.has(BUMP_ROLE_ID)) {
        console.log(`👤 User ${user.tag} already has bump role`);
        return true;
    }
    
    await member.roles.add(role);
    console.log(`✅ Assigned bump role to ${user.tag}`);
    return true;
} catch (error) {
    console.error(`❌ Error assigning bump role to ${user.tag}:`, error);
    return false;
}
```

}

async function requestRoleAssignmentConfirmation(user, guild, minecraftUsername) {
try {
const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
if (!bumpChannel) {
console.error(‘Bump channel not found’);
return;
}

```
    // Check if user already has the role
    const member = await guild.members.fetch(user.id);
    if (member.roles.cache.has(BUMP_ROLE_ID)) {
        console.log(`👤 User ${user.tag} already has bump role, skipping confirmation`);
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
    
    const row = new ActionRowBuilder()
        .addComponents(confirmButton, declineButton);
    
    const embed = new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('🎭 Role Assignment Confirmation')
        .setDescription(`${user}, would you like to receive the **Bump Role**?`)
        .addFields(
            { name: '🎯 Benefits', value: 'Get notified about server events and special perks for active bumpers!' },
            { name: '⏱️ Time Limit', value: 'You have 2 minutes to respond. No response = no role assigned.' },
            { name: '👤 Only You Can See', value: 'This message is only visible to you!' }
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setFooter({ text: 'Choose wisely!' });
    
    const message = await bumpChannel.send({ 
        content: `${user}`,
        embeds: [embed], 
        components: [row] 
    });
    
    // Store pending assignment with timeout
    const timeoutId = setTimeout(async () => {
        await handleRoleTimeout(user.id, message);
    }, 120000); // 120 seconds
    
    pendingRoleAssignments.set(user.id, {
        guild: guild,
        minecraftUsername: minecraftUsername,
        message: message,
        timeoutId: timeoutId
    });
    
    console.log(`⏰ Role assignment confirmation requested for ${user.tag}`);
} catch (error) {
    console.error('Error requesting role assignment confirmation:', error);
}
```

}

async function handleRoleConfirmation(interaction, confirmed) {
try {
const userId = interaction.user.id;
const pendingAssignment = pendingRoleAssignments.get(userId);

```
    if (!pendingAssignment) {
        await interaction.reply({
            content: '❌ No pending role assignment found or it has expired.',
            ephemeral: true
        });
        return;
    }
    
    // Clear the timeout
    clearTimeout(pendingAssignment.timeoutId);
    pendingRoleAssignments.delete(userId);
    
    if (confirmed) {
        // Assign the role
        const roleAssigned = await assignBumpRole(interaction.user, pendingAssignment.guild);
        
        if (roleAssigned) {
            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Role Assigned Successfully!')
                .setDescription(`Welcome to the bump team, ${interaction.user}! 🎉`)
                .addFields(
                    { name: '🎭 Role', value: 'Bump Role', inline: true },
                    { name: '🎮 Status', value: 'Active Bumper', inline: true }
                )
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();
            
            await interaction.update({ embeds: [embed], components: [] });
            
            // Send bump reward message and console command
            const isHiddenUser = HIDDEN_USERS.includes(interaction.user.id);
            await sendBumpRewardMessage(interaction.user, pendingAssignment.minecraftUsername, isHiddenUser);
            await sendConsoleCommand(pendingAssignment.minecraftUsername);
            
            // Delete the message after 10 seconds
            setTimeout(async () => {
                try {
                    await interaction.message.delete();
                } catch (error) {
                    console.log('Could not delete role confirmation message:', error.message);
                }
            }, 10000);
        } else {
            await interaction.update({
                content: '❌ Failed to assign role. Please contact an administrator.',
                embeds: [],
                components: []
            });
        }
    } else {
        // User declined the role
        const embed = new EmbedBuilder()
            .setColor('#808080')
            .setTitle('👋 Role Assignment Declined')
            .setDescription(`No problem, ${interaction.user}! You can always ask for the role later.`)
            .addFields(
                { name: '💡 Note', value: 'Your username is still saved and you\'ll get rewards for bumping!' }
            )
            .setTimestamp();
        
        await interaction.update({ embeds: [embed], components: [] });
        
        // Still send bump reward message and console command even if role is declined
        const isHiddenUser = HIDDEN_USERS.includes(interaction.user.id);
        await sendBumpRewardMessage(interaction.user, pendingAssignment.minecraftUsername, isHiddenUser);
        await sendConsoleCommand(pendingAssignment.minecraftUsername);
        
        // Delete the message after 10 seconds
        setTimeout(async () => {
            try {
                await interaction.message.delete();
            } catch (error) {
                console.log('Could not delete role confirmation message:', error.message);
            }
        }, 10000);
    }
    
    console.log(`🎭 Role assignment ${confirmed ? 'confirmed' : 'declined'} by ${interaction.user.tag}`);
} catch (error) {
    console.error('Error handling role confirmation:', error);
    await interaction.reply({
        content: '❌ An error occurred while processing your response.',
        ephemeral: true
    });
}
```

}

async function handleRoleTimeout(userId, message) {
try {
const pendingAssignment = pendingRoleAssignments.get(userId);
if (!pendingAssignment) return;

```
    pendingRoleAssignments.delete(userId);
    
    const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('⏰ Role Assignment Timed Out')
        .setDescription('No response received within 2 minutes. Role assignment skipped.')
        .addFields(
            { name: '💡 Note', value: 'You can still get the role by using the `!minecraft` command again!' }
        )
        .setTimestamp();
    
    await message.edit({ embeds: [embed], components: [] });
    
    // Still send bump reward message and console command even if timeout occurred
    const user = await client.users.fetch(userId);
    const isHiddenUser = HIDDEN_USERS.includes(userId);
    await sendBumpRewardMessage(user, pendingAssignment.minecraftUsername, isHiddenUser);
    await sendConsoleCommand(pendingAssignment.minecraftUsername);
    
    // Delete the message after 10 seconds
    setTimeout(async () => {
        try {
            await message.delete();
        } catch (error) {
            console.log('Could not delete timeout message:', error.message);
        }
    }, 10000);
    
    console.log(`⏰ Role assignment timed out for user ID: ${userId}`);
} catch (error) {
    console.error('Error handling role timeout:', error);
}
```

}

async function sendBumpRewardMessage(user, minecraftUsername, isHiddenUser = false) {
try {
const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
if (!bumpChannel) {
console.error(‘Bump channel not found’);
return;
}

```
    const displayUsername = isHiddenUser ? '***Hidden***' : minecraftUsername;
    
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🎮 Bump Detected - Reward Sent!')
        .setDescription(`${user} has bumped the server and received rewards! 🎁`)
        .addFields(
            { name: '🎯 Minecraft Username', value: displayUsername, inline: true },
            { name: '⏰ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
            { name: '💰 Rewards', value: '• 1x Balanced Crate Key\n• 3 minutes Temp Fly', inline: false }
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setFooter({ text: 'Thanks for supporting the server!' });
    
    await bumpChannel.send({ embeds: [embed] });
    console.log(`✅ Sent bump reward message for ${user.tag} with ${isHiddenUser ? 'hidden' : 'visible'} username`);
} catch (error) {
    console.error('Error sending bump reward message:', error);
}
```

}

async function sendConsoleCommand(minecraftUsername) {
try {
const consoleChannel = client.channels.cache.get(CONSOLE_CHANNEL_ID);
if (!consoleChannel) {
console.error(‘Console channel not found’);
return;
}

```
    const command = `crate key give ${minecraftUsername} balanced 1 offline`;
    const command1 = `tempfly give ${minecraftUsername} 3m`;
    await consoleChannel.send(command);
    await consoleChannel.send(command1);
    console.log(`💰 Sent console command: ${command}`);
} catch (error) {
    console.error('Error sending console command:', error);
}
```

}

async function promptForMinecraftUsername(user) {
try {
const bumpChannel = client.channels.cache.get(BUMP_CHANNEL_ID);
if (bumpChannel) {
const embed = new EmbedBuilder()
.setColor(’#FFA500’)
.setTitle(‘🎮 Minecraft Username Required’)
.setDescription(`${user}, thanks for bumping! We need your Minecraft username to track your contribution.`)
.addFields(
{ name: ‘📝 Next Steps’, value: ‘Please use the `!minecraft <username>` command to set your username’ },
{ name: ‘❓ Why?’, value: ‘This helps us track server bumps and reward active members’ },
{ name: ‘📖 Example’, value: ‘`!minecraft Steve123`’ }
)
.setTimestamp()
.setFooter({ text: ‘Use !minecraft <username> to set your username’ });

```
        const message = await bumpChannel.send({ content: `${user}`, embeds: [embed] });
        
        // Delete the message after 2 minutes
        setTimeout(async () => {
            try {
                await message.delete();
            } catch (error) {
                console.log('Could not delete prompt message:', error.message);
            }
        }, 120000);
    }
    
    console.log(`❓ Prompted ${user.tag} for Minecraft username`);
} catch (error) {
    console.error('Error prompting for Minecraft username:', error);
}
```

}

async function handleMinecraftUsernameSubmission(interaction) {
try {
const minecraftUsername = interaction.fields.getTextInputValue(‘minecraft_username_input’);
const user = interaction.user;

```
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
    
    // Request role assignment confirmation
    await requestRoleAssignmentConfirmation(user, interaction.guild, minecraftUsername);
    
    console.log(`✅ Added/Updated Minecraft username for ${user.tag}: ${minecraftUsername}`);
} catch (error) {
    console.error('Error handling Minecraft username submission:', error);
    await interaction.reply({
        content: '❌ An error occurred while saving your username. Please try again later.',
        ephemeral: true
    });
}
```

}

async function handleUserCommands(message) {
const args = message.content.slice(1).trim().split(/ +/);
const command = args.shift().toLowerCase();

```
if (command === 'minecraft') {
    await handleMinecraftCommand(message, args);
}
```

}

async function handleMinecraftCommand(message, args) {
try {
// Delete the user’s command message immediately
try {
await message.delete();
} catch (error) {
console.log(‘Could not delete command message:’, error.message);
}

```
    if (args.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('❌ Missing Username')
            .setDescription(`${message.author}, please provide your Minecraft username!`)
            .addFields(
                { name: '📝 Usage', value: '`!minecraft <username>`' },
                { name: '📖 Example', value: '`!minecraft Steve123`' }
            )
            .setTimestamp();
        
        const reply = await message.channel.send({ embeds: [embed] });
        
        // Delete the reply after 30 seconds
        setTimeout(async () => {
            try {
                await reply.delete();
            } catch (error) {
                console.log('Could not delete error message:', error.message);
            }
        }, 30000);
        
        return;
    }
    
    const minecraftUsername = args[0];
    
    // Validate Minecraft username
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(minecraftUsername)) {
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Invalid Username')
            .setDescription(`${message.author}, Minecraft usernames must be 3-16 characters long and contain only letters, numbers, and underscores.`)
            .addFields(
                { name: '📝 Valid Examples', value: '`Steve`, `Notch`, `Player123`, `Cool_Gamer`' },
                { name: '❌ Invalid Examples', value: '`AB`, `ThisNameIsTooLong123`, `Player-123`, `User@123`' }
            )
            .setTimestamp();
        
        const reply = await message.channel.send({ embeds: [embed] });
        
        // Delete the reply after 30 seconds
        setTimeout(async () => {
            try {
                await reply.delete();
            } catch (error) {
                console.log('Could not delete error message:', error.message);
            }
        }, 30000);
        
        return;
    }
    
    // Check if user already exists in database
    const existingUser = await getUserFromNocoDB(message.author.id);
    let isUpdate = false;
    
    if (existingUser) {
        // Update existing user
        await updateUserInNocoDB(existingUser.Id, minecraftUsername);
        isUpdate = true;
    } else {
        // Add new user
        await addUserToNocoDB(message.author.id, message.author.tag, minecraftUsername);
    }
    
    // Send success message
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(isUpdate ? '✅ Username Updated!' : '✅ Registration Successful!')
        .setDescription(`${message.author}, your Minecraft username has been ${isUpdate ? 'updated' : 'registered'}: **${minecraftUsername}**`)
        .addFields(
            { name: '🎮 Username Set', value: minecraftUsername, inline: true },
            { name: '📝 Next Step', value: 'Bump the server to get your rewards!' }
        )
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setFooter({ text: 'Minecraft Tracker Bot' });
    
    const reply = await message.channel.send({ embeds: [embed] });
    
    // Delete the success message after 1 minute
    setTimeout(async () => {
        try {
            await reply.delete();
        } catch (error) {
            console.log('Could not delete success message:', error.message);
        }
    }, 60000);
    
    // Request role assignment confirmation (only for new users or users without the role)
    if (!isUpdate || !await checkUserHasRole(message.author, message.guild)) {
        await requestRoleAssignmentConfirmation(message.author, message.guild, minecraftUsername);
    }
    
    console.log(`✅ User ${message.author.tag} ${isUpdate ? 'updated' : 'set'} Minecraft username via !minecraft: ${minecraftUsername}`);
} catch (error) {
    console.error('Error handling !minecraft command:', error);
    
    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Error')
        .setDescription(`${message.author}, an error occurred while saving your username. Please try again later.`)
        .setTimestamp();
    
    const reply = await message.channel.send({ embeds: [embed] });
    
    // Delete the error message after 30 seconds
    setTimeout(async () => {
        try {
            await reply.delete();
        } catch (error) {
            console.log('Could not delete error message:', error.message);
        }
    }, 30000);
}
```

}

async function checkUserHasRole(user, guild) {
try {
const member = await guild.members.fetch(user.id);
return member.roles.cache.has(BUMP_ROLE_ID);
} catch (error) {
console.error(‘Error checking user role:’, error);
return false;
}
}

// Health check endpoints
app.get(’/’, (req, res) => {
res.json({
status: ‘Minecraft Tracker Bot is running!’,
uptime: process.uptime(),
timestamp: new Date().toISOString(),
bot_status: client.user ? ‘connected’ : ‘disconnected’
});
});

app.get(’/health’, (req, res) => {
res.json({
status: ‘healthy’,
bot: client.user ? ‘connected’ : ‘disconnected’,
guilds: client.guilds.cache.size,
nocodb_configured: !!NOCODB_BASE_URL
});
});

app.listen(PORT, () => {
console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// Error handling
client.on(‘error’, console.error);
process.on(‘unhandledRejection’, (error) => {
console.error(‘Unhandled promise rejection:’, error);
});

// Login to Discord
client.login(DISCORD_BOT_TOKEN).catch(console.error);

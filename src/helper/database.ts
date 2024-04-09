import { google } from 'googleapis';
import { schedule } from 'node-cron';
import Database from 'better-sqlite3';
import { JWT } from 'google-auth-library';
import { EmbedBuilder, Guild, GuildMember, Role } from 'discord.js';
import { SkyblockMember } from 'hypixel-api-reborn';
import config from '../config.json' assert { type: 'json' };
import {
  uuidToName,
  doubleDigits,
  abbreviateNumber,
  rankTagF,
  formatDateForDb,
  getESTDate,
  updateTable
} from './utils.js';
import { bwPrestiges, guildMemberRoles, hypixelRoles } from './constants.js';
import { HypixelGuildMember, HypixelRoleKeys, StringObject } from '../types/global.d.js';
import { textChannels } from '../events/discord/ready.js';
import { chat } from '../handlers/workerHandler.js';
import client, { hypixel } from '../index.js';
import { archiveGuildMember, archiveMember, createGuildMember } from '../handlers/databaseHandler.js';
import { checkRequirements } from './requirements.js';

const db = new Database('guild.db');

export const sheet = new google.auth.JWT(config.sheets.clientEmail, undefined, config.sheets.privateKey, [
  'https://www.googleapis.com/auth/spreadsheets'
]);

sheet.authorize();
const roleOrder = ['slayer', 'elite', 'hero', 'supreme', 'dominator', 'goat'];

async function removeHigherRoles(member: GuildMember, currentRole: string, roles: { [key: string]: Role }) {
  const currentRoleIndex = roleOrder.indexOf(currentRole);
  for (let i = currentRoleIndex + 1; i < roleOrder.length; i++) {
    const roleKey = roleOrder[i];
    if (member.roles.cache.has(roles[roleKey].id)) {
      await member.roles.remove(roles[roleKey]);
    }
  }

  // Remove elite role from hero members
  if (member.roles.cache.has(config.roles.hero)) {
    if (member.roles.cache.has(config.roles.elite)) {
      await member.roles.remove(config.roles.elite);
    }
  }

  // Remove member roles from staff
  if (member.roles.cache.has(config.roles.eventStaff) || member.roles.cache.has(config.roles.recruitmentStaff)) {
    for (let i = currentRoleIndex + 1; i < roleOrder.length; i++) {
      const roleKey = roleOrder[i];
      if (member.roles.cache.has(roles[roleKey].id) && roles[roleKey].name !== 'slayer' && roleKey !== currentRole) {
        await member.roles.remove(roles[roleKey]);
      }
    }
  }
}

export async function weekly() {
  schedule(
    '55 12 * * 0',
    async () => {
      const roleDesc: StringObject = {};
      const assignedMembers = new Set();

      for (const [role, data] of Object.entries(hypixelRoles)) {
        roleDesc[role] = '';

        const roleMembers = db
          .prepare(
            `SELECT uuid, discord, weeklyGexp, joined FROM guildMembers WHERE weeklyGexp >= (?) AND uuid NOT IN (${Array.from(
              assignedMembers
            )
              .map(() => '?')
              .join(',')}) ORDER BY weeklyGexp DESC`
          )
          .all(data.gexp, ...Array.from(assignedMembers)) as HypixelGuildMember[];

        roleMembers.sort((a, b) => b.weeklyGexp - a.weeklyGexp);

        for (const i in roleMembers) {
          assignedMembers.add(roleMembers[i].uuid);

          const days =
            (new Date().getTime() - new Date(parseInt(roleMembers[i].joined, 10)).getTime()) / (1000 * 3600 * 24);

          if (days >= data.days) {
            for (const j in hypixelRoles) {
              if (days >= hypixelRoles[j as HypixelRoleKeys].days) {
                db.prepare('UPDATE guildMembers SET targetRank = ? WHERE uuid = ?').run(
                  `[${hypixelRoles[j as HypixelRoleKeys].name}]`,
                  roleMembers[i].uuid
                );
                break;
              }
            }
          } else {
            db.prepare('UPDATE guildMembers SET targetRank = ? WHERE uuid = ?').run(
              `[${data.name}]`,
              roleMembers[i].uuid
            );
          }

          if (roleMembers[i].discord) {
            roleDesc[role] += `\n\`${parseInt(i, 10) + 1}.\` ${await client.users.fetch(
              roleMembers[i].discord
            )} - \`${abbreviateNumber(roleMembers[i].weeklyGexp)}\``;
          } else {
            roleDesc[role] += `\n\`${parseInt(i, 10) + 1}.\` ${await uuidToName(
              roleMembers[i].uuid
            )} - \`${abbreviateNumber(roleMembers[i].weeklyGexp)}\``;
          }
        }
      }

      const slayerMembers = db
        .prepare(
          `SELECT uuid, discord, weeklyGexp, joined FROM guildMembers WHERE uuid NOT IN (${Array.from(assignedMembers)
            .map(() => '?')
            .join(',')})`
        )
        .all(...Array.from(assignedMembers)) as HypixelGuildMember[];

      for (const i in slayerMembers) {
        const days =
          (new Date().getTime() - new Date(parseInt(slayerMembers[i].joined, 10)).getTime()) / (1000 * 3600 * 24);

        for (const j in hypixelRoles) {
          if (days >= hypixelRoles[j as HypixelRoleKeys].days) {
            db.prepare('UPDATE guildMembers SET targetRank = ? WHERE uuid = ?').run(
              `[${hypixelRoles[j as HypixelRoleKeys].name}]`,
              slayerMembers[i].uuid
            );
            break;
          }
        }
      }

      const date = new Date();
      date.setDate(date.getDate() - 1);
      const previous = `${doubleDigits(date.getDate())}/${doubleDigits(date.getMonth() + 1)}/${date.getFullYear()}`;
      date.setDate(date.getDate() - 6);
      const prevWeek = `${doubleDigits(date.getDate())}/${doubleDigits(date.getMonth() + 1)}/${date.getFullYear()}`;

      const embed = new EmbedBuilder()
        .setColor(config.colors.discordGray)
        .setTitle(`Weekly Roles Update ${prevWeek} - ${previous}`)
        .setDescription(
          `${Object.entries(roleDesc)
            .filter(([, desc]) => desc.trim() !== '')
            .map(
              ([role, desc]) =>
                `Congrats to the following **${hypixelRoles[role as HypixelRoleKeys].name}** members:${desc}`
            )
            .join('\n\n')}\n\n**Detailed stats can be found in https://dominance.cf/sheets**`
        )
        .setImage(config.guild.banner);

      await textChannels.announcements.send({ content: '<@&1031926129822539786>', embeds: [embed] });
    },
    {
      timezone: 'Asia/Hong_Kong'
    }
  );
}

export async function database() {
  setInterval(async () => {
    const guild = await hypixel.getGuild('name', 'Dominance', {});
    const today = getESTDate();

    const tableInfo = db.prepare('PRAGMA table_info(gexpHistory)').all() as StringObject[];
    const columnExists = tableInfo.some((column) => column.name === formatDateForDb(today));

    if (!columnExists) {
      db.prepare(`ALTER TABLE gexpHistory ADD COLUMN "${formatDateForDb(today)}" INTEGER DEFAULT 0`).run();
      db.prepare(`ALTER TABLE gexpHistoryArchives ADD COLUMN "${formatDateForDb(today)}" INTEGER`).run();
    }

    updateTable('2022-10-17', formatDateForDb(today));

    for (const member of guild.members) {
      const { joinedAtTimestamp, uuid, rank, expHistory } = member;
      const weeklyGexp = member.expHistory.reduce((acc, cur) => acc + cur.exp, 0);
      const currentDay = expHistory[0].day;
      const currentDailyExp = expHistory[0].exp;

      createGuildMember(uuid);

      db.prepare(`UPDATE guildMembers SET (joined, tag, weeklyGexp) = (?, ?, ?) WHERE uuid = ?`).run(
        joinedAtTimestamp,
        `[${rank}]`,
        weeklyGexp,
        uuid
      );

      db.prepare(`UPDATE gexpHistory SET ("${currentDay}") = (?) WHERE uuid = ?`).run(currentDailyExp, uuid);
    }

    const hypixelMemberUuids = guild.members.map((member) => member.uuid);

    const uuidsToCheck = [
      ...(db.prepare('SELECT uuid FROM guildMembers').all() as { uuid: string }[]),
      ...(db.prepare('SELECT uuid FROM gexpHistory').all() as { uuid: string }[])
    ];

    for (const uuid of uuidsToCheck) {
      if (!hypixelMemberUuids.includes(uuid.uuid)) {
        await archiveGuildMember(null, uuid.uuid);
      }
    }
  }, 60 * 1000);
}

export async function gsrun(sheets: JWT) {
  setInterval(
    async () => {
      const gsapi = google.sheets({ version: 'v4', auth: sheets });
      const data = db.prepare('SELECT * FROM guildMembers').all() as HypixelGuildMember[];
      const guild = await hypixel.getGuild('name', 'Dominance', {});

      const array = await Promise.all(
        data.map(async (member) => {
          member.name = await uuidToName(member.uuid);
          guild.members
            .find((m) => m.uuid === member.uuid)
            ?.expHistory.forEach((day) => {
              member[day.day] = day.exp;
            });

          const discordTag = member.discord ? (await client.users.fetch(member.discord))?.tag ?? null : null;

          const { name, discord, nameColor, targetRank, ...rest } = member;

          const expHistory = Object.keys(rest).reduce((acc: { [key: string]: any }, key) => {
            if (key.match(/^\d{4}-\d{2}-\d{2}$/)) {
              acc[key] = rest[key];
              delete rest[key];
            }
            return acc;
          }, {});

          return [name, discordTag, ...Object.values(expHistory), ...Object.values(rest)];
        })
      );

      array.sort((a: any, b: any) => b[4] - a[4]);
      const options = {
        spreadsheetId: '1YiNxpvH9FZ6Cl6ZQmBV07EvORvsVTAiq5kD1FgJiKEE',
        range: 'Guild API!A2',
        valueInputOption: 'USER_ENTERED',
        resource: { values: array }
      };

      await gsapi.spreadsheets.values.clear({
        spreadsheetId: '1YiNxpvH9FZ6Cl6ZQmBV07EvORvsVTAiq5kD1FgJiKEE',
        range: 'Guild API!A2:Z126'
      });
      await gsapi.spreadsheets.values.update(options);
    },
    6 * 60 * 1000
  );
}

export async function players() {
  let count = 0;
  const guild = client.guilds.cache.get('242357942664429568') as Guild;

  function getRole(roleId: string) {
    return guild.roles.cache.get(roleId) as Role;
  }

  const roles = {
    unverified: getRole(config.roles.unverified),
    break: getRole(config.roles.break),
    slayer: getRole(config.roles.slayer),
    elite: getRole(config.roles.elite),
    hero: getRole(config.roles.hero),
    supreme: getRole(config.roles.supreme),
    dominator: getRole(config.roles.dominator),
    goat: getRole(config.roles.goat),
    eventStaff: getRole(config.roles.eventStaff),
    recruitmentStaff: getRole(config.roles.recruitmentStaff)
  };

  setInterval(
    async () => {
      const discordId = db
        .prepare('SELECT discord FROM guildMembers')
        .all()
        .map((i) => (i as { discord: string }).discord);
      const members = Array.from(roles.slayer.members).concat(
        Array.from(roles.elite.members),
        Array.from(roles.hero.members),
        Array.from(roles.supreme.members),
        Array.from(roles.dominator.members),
        Array.from(roles.goat.members),
        Array.from(roles.recruitmentStaff.members),
        Array.from(roles.eventStaff.members)
      );
      for (const member of members) {
        if (!discordId.includes(member[0])) {
          await member[1].roles.remove(guildMemberRoles);
        }
      }
    },
    5 * 60 * 1000
  );

  setInterval(async () => {
    const data = db.prepare('SELECT * FROM guildMembers LIMIT 1 OFFSET ?').get(count) as HypixelGuildMember;

    count++;
    if (count === 126) {
      count = 0;
    }

    if (!data || !data.uuid || !data.tag) {
      return;
    }

    const ingameRole = data.tag.replace(/\[|\]/g, '');
    const targetRole = data.targetRank?.slice(1, -1) ?? '';

    let player;
    try {
      player = await hypixel.getPlayer(data.uuid);
    } catch (e) {
      return;
    }

    const bwFkdr = +(player.stats?.bedwars?.finalKDRatio.toFixed(1) ?? 0);
    const bwStars = player.stats?.bedwars?.level ?? 0;
    const duelsWins = player.stats?.duels?.wins ?? 0;
    const duelsWlr = +(player.stats?.duels?.WLRatio.toFixed(1) ?? 0);

    let networth = 0;
    let sbSkillAverage = 0;
    let sbLevel = 0;
    const sbMember = await hypixel.getSkyblockMember(data.uuid).catch(() => null);
    if (sbMember) {
      const profile = sbMember.values().next().value as SkyblockMember;
      networth = (await profile.getNetworth()).networth ?? 0;
      sbSkillAverage = profile.skills.average;
      sbLevel = profile.level;
    }

    if (data.targetRank && !['[Staff]', '[Owner]', '[GM]'].includes(data.tag) && data.targetRank !== data.tag) {
      const ign = await uuidToName(data.uuid);
      if (data.targetRank === '[Hero]') {
        chat(`/g promote ${ign}`);
      } else if (data.targetRank === '[Elite]') {
        if (data.tag === '[Slayer]') {
          chat(`/g promote ${ign}`);
        } else if (data.tag === '[Hero]') {
          chat(`/g demote ${ign}`);
        }
      } else if (data.targetRank === '[Slayer]') {
        chat(`/g demote ${ign}`);
      } else if (['[Slayer]', '[Elite]'].includes(data.tag)) {
        chat(`/g promote ${ign}`);
      }
    } else if (!data.targetRank && ['Elite', 'Hero'].includes(ingameRole)) {
      const ign = await uuidToName(data.uuid);
      chat(`/g demote ${ign}`);
    }

    if (data.discord) {
      let member;
      try {
        member = await guild.members.fetch(data.discord);
      } catch (e) {
        await archiveMember(null, data.discord);
        return;
      }

      // Bedwars roles
      const bwRole = bwPrestiges[Math.floor(bwStars / 100) * 100];
      for (const roleId of Object.values(bwPrestiges)) {
        if (member.roles.cache.has(roleId) && roleId !== bwRole) {
          await member.roles.remove(roleId);
        }
      }
      if (bwRole) {
        await member.roles.add(bwRole);
      }

      if (!['[Owner]', '[GUILDMASTER]'].includes(data.tag)) {
        // Set member discord nicknames
        const ign = player.nickname;
        const { displayName } = member;
        if (!displayName.toUpperCase().includes(ign.toUpperCase())) {
          if (/\(.*?\)/.test(displayName.split(' ')[1])) {
            await member.setNickname(displayName.replace(displayName.split(' ')[0], ign));
          } else {
            await member.setNickname(ign);
          }
        } else if (!displayName.includes(ign)) {
          await member.setNickname(displayName.replace(new RegExp(ign, 'gi'), ign));
        }

        // Manage member roles
        const memberRoles = member.roles.cache.map((role) => role.id);

        // Add default member role
        if (!memberRoles.includes(config.roles.slayer)) {
          await member.roles.add(roles.slayer);
        }

        // Remove unverified role
        if (!memberRoles.includes(config.roles.unverified)) {
          await member.roles.remove(roles.unverified);
        }

        // Add in-game role
        if (ingameRole !== 'Staff') {
          const role = roles[ingameRole.toLowerCase() as HypixelRoleKeys];
          if (!memberRoles.includes(role.id)) {
            await member.roles.add(role);
          }
        }

        if (ingameRole === 'Hero' && ['[Supreme]', '[Dominator]', '[Goat]'].includes(data.targetRank)) {
          // Add higher role
          const role = roles[targetRole.toLowerCase() as HypixelRoleKeys];
          if (!memberRoles.includes(role.id)) {
            await member.roles.add(role);
          }
        }

        // Remove higher roles
        if (['Slayer', 'Elite'].includes(ingameRole)) {
          await removeHigherRoles(member, ingameRole.toLowerCase(), roles);
        } else if (ingameRole === 'Hero' && targetRole) {
          await removeHigherRoles(member, targetRole.toLowerCase(), roles);
        } else if (ingameRole === 'Staff') {
          if (targetRole) {
            // Add weekly role
            await removeHigherRoles(member, targetRole.toLowerCase(), roles);
          } else {
            // Remove weekly roles
            await removeHigherRoles(member, 'slayer', roles);
          }
        }
      }

      // Days in guild roles
      const days = (new Date().getTime() - new Date(parseInt(data.joined, 10)).getTime()) / (1000 * 3600 * 24);

      const dayRoles = Object.keys(config.roles.days).map(Number);

      let highestRole = 0;

      for (const day of dayRoles) {
        if (days >= day) {
          highestRole = day;
        }
      }

      if (highestRole) {
        await member.roles.add((config.roles.days as { [key: string]: string })[highestRole.toString()]);
      }

      for (const day of dayRoles) {
        if (
          day !== highestRole &&
          member.roles.cache.has((config.roles.days as { [key: string]: string })[day.toString()])
        ) {
          await member.roles.remove((config.roles.days as { [key: string]: string })[day.toString()]);
        }
      }
    }

    const swLevel = player.stats?.skywars?.level ?? 0;
    const { achievementPoints, level } = player;
    const quests = player.achievements.generalQuestMaster;

    db.prepare(
      'UPDATE guildMembers SET (nameColor, reqs, bwStars, bwFkdr, duelsWins, duelsWlr, networth, skillAverage, swLevel, achievementPoints, networkLevel, sbLevel, quests) = (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) WHERE uuid = ?'
    ).run(
      rankTagF(player),
      (await checkRequirements(data.uuid, player)) ? 1 : 0,
      bwStars,
      bwFkdr,
      duelsWins,
      duelsWlr,
      Math.round(networth * 100) / 100 ?? 0,
      Math.round(sbSkillAverage * 100) / 100 ?? 0,
      swLevel,
      achievementPoints,
      level,
      sbLevel,
      quests,
      data.uuid
    );
  }, 7 * 1000);

  setInterval(
    async () => {
      const breakMembers = db
        .prepare('SELECT discord FROM breaks')
        .all()
        .map((i) => (i as { discord: string }).discord);
      for (const member of Array.from(roles.break.members)) {
        if (!breakMembers.includes(member[0])) {
          await member[1].roles.remove(roles.break);
        }
      }
    },
    5 * 60 * 1000
  );
}

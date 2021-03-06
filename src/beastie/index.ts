import config from "../config";
import TwitchWebhooksServer from "../services/twitchWebhooks";
import BeastieTwitterClient from "../services/twitter";
import handleStreamChange from "../services/twitchWebhooks/streamChange";
import BeastieTwitchClient from "../services/twitch";
import { POST_EVENT } from "../utils/values";
import BeastieDiscordClient from "../services/discord";
import { BeastieLogger } from "../utils/Logging";
import { checkTeammateTable } from "../services/db";
import { broadcaster } from "../services/twitch/TwitchAPI";
import { TwitchStream } from "../services/twitch/TwitchAPI/apiTypes";

interface StateType {
    isStreaming: boolean;
    curStreamId: string;
}

export default class BeastieBot {
    state: StateType;

    twitchClient: BeastieTwitchClient;
    twitchWebhooks: TwitchWebhooksServer;
    discordClient: BeastieDiscordClient;
    twitterClient: BeastieTwitterClient;

    broadcasterId: string;

    private constructor() {}

    public static async create() {
        if (!(await checkTeammateTable())) {
            throw `Issue checking on database, see log`;
        }

        const beastie = new BeastieBot();

        beastie.state = {
            isStreaming: false,
            curStreamId: "0"
        };

        beastie.twitchClient = beastie.initTwitch();
        beastie.broadcasterId = (await broadcaster.getProfile())?.id;
        beastie.twitchWebhooks = await beastie.initTwitchWebhooks();
        beastie.discordClient = beastie.initDiscord();
        beastie.twitterClient = beastie.initTwitter();

        beastie.state = await beastie.initState();

        BeastieLogger.info("init finished");
        return beastie;
    }

    async destroy() {
        let results = await Promise.allSettled([
            this.twitchClient.destroy(),
            this.twitchWebhooks.destroy(),
            this.discordClient.destroy(),
            this.twitterClient.destroy()
        ]);

        let rejResult = results.find(
            rsp => rsp.status === "rejected"
        ) as PromiseRejectedResult;
        if (rejResult) {
            throw rejResult.reason;
        }

        delete this.twitchClient;
        delete this.discordClient;
        delete this.twitterClient;
        delete this.twitchWebhooks;
    }

    initTwitch() {
        const twitchClient = new BeastieTwitchClient();

        // Twitch Event Listeners that affect other services

        BeastieLogger.info("twitch init finished");
        return twitchClient;
    }

    async initTwitchWebhooks() {
        const twitchWebhooks = new TwitchWebhooksServer();
        await twitchWebhooks.connect(this.broadcasterId);

        // Twitch Webhooks Event Listeners that affect other services
        twitchWebhooks.emitter.on("stream changed", async payload => {
            await this.onStreamChange(payload);
        });

        twitchWebhooks.emitter.on("users follows", async payload => {
            await this.onFollow(payload);
        });

        // TODO: Add listener for subscriber event

        BeastieLogger.info("twitch webhooks init finished");
        return twitchWebhooks;
    }

    initTwitter() {
        const twitterClient = new BeastieTwitterClient();

        // Twitter Event Listeners that affect other services

        BeastieLogger.info("twitter init finished");
        return twitterClient;
    }

    initDiscord() {
        const discordClient = new BeastieDiscordClient();

        discordClient.client.on("message", message => {
            this.onDiscordMessage(message);
        });

        BeastieLogger.info("discord init finished");
        return discordClient;
    }

    initState = async (): Promise<StateType> => {
        const stream: TwitchStream = await broadcaster.getStream();

        BeastieLogger.info("state init finished");
        return {
            ...this.state,
            isStreaming: stream?.type === "live",
            curStreamId: stream?.id
        };
    };

    public async start() {
        await this.twitchClient.client.connect();
        await this.discordClient.client.login(config.DISCORD_TOKEN);
        this.twitchClient.toggleStreamIntervals(this.state.isStreaming);
    }

    private async onStreamChange(payload) {
        if (payload.data[0]) {
            const stream = payload.data[0];
            const response = handleStreamChange(stream, this.state.curStreamId);

            this.state.isStreaming = response.live;
            this.state.curStreamId = response.streamId.toString();

            if (response.newStream) {
                this.twitterClient
                    .post(POST_EVENT.TWITTER_LIVE, this.state.curStreamId)
                    .catch(reason => {
                        BeastieLogger.warn(
                            `Failed to complete twitter POST_EVENT.TWITTER_LIVE: ${reason}`
                        );
                    });
                this.discordClient
                    .post(POST_EVENT.DISCORD_LIVE)
                    .catch(reason => {
                        BeastieLogger.warn(
                            `Failed to complete discord POST_EVENT.DISCORD_LIVE: ${reason}`
                        );
                    });
                // TODO: Add file with functionality for Beastie to post to places outside of teamTALIMA's community
            }
        } else {
            this.state.isStreaming = false;
            if (this.state.curStreamId !== "0") {
                try {
                    await this.twitchClient.post(
                        POST_EVENT.END_OF_STREAM,
                        null
                    );
                } catch (e) {
                    BeastieLogger.warn(
                        `Failed to post end-of-stream message: ${e}`
                    );
                }
            }
        }

        this.twitchClient.toggleStreamIntervals(this.state.isStreaming);
    }

    private async onFollow(payload) {
        try {
            const { from_name } = payload.data[0];
            await this.twitchClient.post(
                POST_EVENT.TWITCH_NEW_FOLLOW,
                from_name
            );
        } catch (e) {
            BeastieLogger.warn(`Failed to post follow message: ${e}`);
        }
        // twitter and discord post for follow milestones per stream
    }

    private async onSubscribe(payload) {
        try {
            const { user_name } = payload.event.data[0].event_data;
            await this.twitchClient.post(POST_EVENT.TWITCH_NEW_SUB, user_name);
        } catch (e) {
            BeastieLogger.warn(`Failed to post subscription message: ${e}`);
        }
        // twitter and discord post for subscriber milestones per stream
    }

    private onDiscordMessage = message => {
        if (message.channel.id === this.discordClient.discordTalimasFeedChId)
            if (this.twitterClient) {
                this.twitterClient.postMessage(message);
            }
    };
}

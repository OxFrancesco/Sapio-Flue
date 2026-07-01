import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import {
  InlineNotice,
  NeoBadge,
  NeoButton,
  NeoCard,
  NeoInput,
  NeoRow,
  Screen,
  SectionTitle,
} from '@/components/neo';
import { useApp } from '@/lib/store';
import { space, type } from '@/lib/theme';
import type { WorkspaceDetails } from '@/lib/types';

export default function WorkspaceScreen() {
  const router = useRouter();
  const { configured, bootstrap, api, refreshBootstrap } = useApp();
  const [details, setDetails] = useState<WorkspaceDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<'pro' | 'team' | null>(null);

  const workspaceId = bootstrap?.context?.workspace.id;

  const loadDetails = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const response = await api.workspace();
      setDetails(response.details);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  const createInvite = useCallback(async () => {
    if (inviting) return;
    setInviting(true);
    try {
      const invite = await api.invite();
      setInviteCode(invite.code);
    } catch (caught) {
      Alert.alert('Unable to create invite', caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInviting(false);
    }
  }, [api, inviting]);

  const joinWorkspace = useCallback(async () => {
    const code = joinCode.trim();
    if (!code || joining) return;
    setJoining(true);
    try {
      const joined = await api.join(code);
      setJoinCode('');
      await refreshBootstrap();
      await loadDetails();
      Alert.alert('Joined workspace', `This app now uses ${joined.workspace.name}.`);
    } catch (caught) {
      Alert.alert('Unable to join workspace', caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJoining(false);
    }
  }, [api, joinCode, joining, loadDetails, refreshBootstrap]);

  const startCheckout = useCallback(
    async (plan: 'pro' | 'team') => {
      if (checkoutPlan) return;
      setCheckoutPlan(plan);
      try {
        const checkout = await api.billingCheckout(plan);
        await WebBrowser.openBrowserAsync(checkout.url);
        await refreshBootstrap();
        await loadDetails();
      } catch (caught) {
        Alert.alert(
          'Unable to start billing checkout',
          caught instanceof Error ? caught.message : String(caught),
        );
      } finally {
        setCheckoutPlan(null);
      }
    },
    [api, checkoutPlan, loadDetails, refreshBootstrap],
  );

  if (!configured || !bootstrap) {
    return (
      <Screen title="Space">
        <NeoCard accent>
          <Text style={type.subheading}>Not connected</Text>
          <Text style={type.body}>Connect the app in Setup first.</Text>
          <NeoButton label="Open setup" variant="accent" onPress={() => router.push('/settings')} />
        </NeoCard>
      </Screen>
    );
  }

  if (!bootstrap.convexConfigured || !bootstrap.context) {
    return (
      <Screen title="Space">
        <NeoCard>
          <Text style={type.subheading}>Workspace sign-in unavailable</Text>
          <Text style={type.body}>
            Convex is not configured for this Worker yet. Set CONVEX_URL and deploy the Convex
            schema/functions to enable signed-in users and study workspaces.
          </Text>
        </NeoCard>
      </Screen>
    );
  }

  const workspace = details?.workspace ?? bootstrap.context.workspace;
  const role = details?.membership.role ?? bootstrap.context.membership.role;

  return (
    <Screen title="Space" badge={workspace.plan.toUpperCase()}>
      <SectionTitle label="Study workspace" />
      <NeoCard>
        <NeoRow label="Name" value={workspace.name} />
        <NeoRow label="Kind" value={workspace.kind.replaceAll('_', ' ')} />
        <NeoRow label="Plan" value={workspace.plan} />
        <NeoRow
          label="Billing"
          value={workspace.billingMode === 'byok' ? 'bring your own key' : 'platform'}
        />
        <NeoRow label="Your role" value={role} />
        <NeoButton label="Reload" variant="ghost" loading={loading} onPress={() => void loadDetails()} />
      </NeoCard>
      {error ? <InlineNotice text={error} /> : null}

      <SectionTitle label="Members" />
      <NeoCard>
        {(details?.members ?? []).length === 0 ? (
          <Text style={type.body}>No active members found.</Text>
        ) : (
          details?.members.map((member) => (
            <View key={member.userId} style={styles.memberRow}>
              <Text style={type.body} numberOfLines={1}>
                {member.displayName}
                {member.username ? ` @${member.username}` : ''}
              </Text>
              <NeoBadge label={member.role} accent={member.role !== 'member'} />
            </View>
          ))
        )}
      </NeoCard>

      <SectionTitle label="Invite friends" />
      <NeoCard>
        {inviteCode ? (
          <>
            <Text style={type.small}>Friends join with this code (or /join in Telegram):</Text>
            <Text style={styles.inviteCode}>{inviteCode}</Text>
            <NeoButton
              label="Copy code"
              onPress={() => {
                void Clipboard.setStringAsync(inviteCode);
              }}
            />
          </>
        ) : null}
        <NeoButton
          label={inviteCode ? 'New invite code' : 'Create invite code'}
          variant="accent"
          loading={inviting}
          onPress={() => void createInvite()}
        />
      </NeoCard>

      <SectionTitle label="Join a workspace" />
      <NeoCard>
        <NeoInput
          value={joinCode}
          onChangeText={setJoinCode}
          placeholder="Invite code"
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <NeoButton
          label="Join workspace"
          loading={joining}
          disabled={!joinCode.trim()}
          onPress={() => void joinWorkspace()}
        />
      </NeoCard>

      <SectionTitle label="Billing" />
      <NeoCard accent={workspace.plan === 'free'}>
        <Text style={type.body}>
          {workspace.plan === 'free'
            ? 'Subscribe to use platform-hosted ZAI/Codex models, or attach an OpenAI key in the Model tab.'
            : 'This workspace can use platform-hosted models.'}
        </Text>
        {!bootstrap.polarConfigured ? (
          <InlineNotice text="Polar billing is not configured on the server yet." />
        ) : null}
        <View style={styles.billingRow}>
          <NeoButton
            label="Pro"
            variant="accent"
            loading={checkoutPlan === 'pro'}
            disabled={!bootstrap.polarConfigured}
            onPress={() => void startCheckout('pro')}
            style={styles.billingButton}
          />
          <NeoButton
            label="Team"
            loading={checkoutPlan === 'team'}
            disabled={!bootstrap.polarConfigured}
            onPress={() => void startCheckout('team')}
            style={styles.billingButton}
          />
        </View>
      </NeoCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xs,
    paddingVertical: 4,
  },
  inviteCode: {
    ...type.heading,
    letterSpacing: 4,
  },
  billingRow: {
    flexDirection: 'row',
    gap: space.xs,
  },
  billingButton: {
    flex: 1,
  },
});

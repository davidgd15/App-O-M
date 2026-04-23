import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import {
  Alert,
  Button,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { db } from './firebaseConfig';
import { collection, query, orderBy, onSnapshot, addDoc } from 'firebase/firestore';
import NetInfo from '@react-native-community/netinfo';

// ---------- Função para formatar data/hora ----------
const formatDateTime = (date: Date): string => {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
};

// ---------- Tipagens ----------
type Module = {
  id: number;
  code: string;
  timestamp: string;
};

type Batch = {
  id?: string;
  batchId: string;
  modules: Module[];
  createdAt: string;
  synced?: boolean;
};

type BatchesContextType = {
  batches: Batch[];
  addBatch: (batch: Batch) => Promise<void>;
  loading: boolean;
  syncPendingBatches: (showAlert?: boolean) => Promise<void>; // alterado
};

type CurrentBatchContextType = {
  currentBatchId: string | null;
  currentModules: Module[];
  createNewBatch: () => Promise<boolean>;
  addModuleToCurrentBatch: (code: string) => Promise<boolean>;
  resetCurrentBatch: () => void;
};

// ---------- Contextos ----------
const BatchesContext = createContext<BatchesContextType | undefined>(undefined);
const CurrentBatchContext = createContext<CurrentBatchContextType | undefined>(undefined);

const useBatches = () => {
  const ctx = useContext(BatchesContext);
  if (!ctx) throw new Error('useBatches must be used within BatchesProvider');
  return ctx;
};

const useCurrentBatch = () => {
  const ctx = useContext(CurrentBatchContext);
  if (!ctx) throw new Error('useCurrentBatch must be used within CurrentBatchProvider');
  return ctx;
};

// ---------- Provider com suporte offline ----------
const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [currentModules, setCurrentModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);

  // Carregar cache local e pendentes ao iniciar
  useEffect(() => {
    const loadLocalData = async () => {
      try {
        const cached = await AsyncStorage.getItem('@batches_cache');
        const firestoreBatches: Batch[] = cached ? JSON.parse(cached) : [];
        const pendingRaw = await AsyncStorage.getItem('@pending_batches');
        const pending: Batch[] = pendingRaw ? JSON.parse(pendingRaw) : [];
        setBatches([...pending, ...firestoreBatches]);
      } catch (error) {
        console.error('Erro ao carregar dados locais:', error);
      }
    };
    loadLocalData();
  }, []);

  // Escutar Firestore e atualizar cache + remover pendentes já sincronizados
  useEffect(() => {
    const q = query(collection(db, 'batches'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const firestoreBatches: Batch[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        firestoreBatches.push({
          id: doc.id,
          batchId: data.batchId,
          modules: data.modules,
          createdAt: data.createdAt,
          synced: true,
        });
      });
      await AsyncStorage.setItem('@batches_cache', JSON.stringify(firestoreBatches));

      const pendingRaw = await AsyncStorage.getItem('@pending_batches');
      let pending: Batch[] = pendingRaw ? JSON.parse(pendingRaw) : [];
      const newPending = pending.filter(p => !firestoreBatches.some(fb => fb.batchId === p.batchId));
      if (newPending.length !== pending.length) {
        await AsyncStorage.setItem('@pending_batches', JSON.stringify(newPending));
        pending = newPending;
      }
      setBatches([...pending, ...firestoreBatches]);
      setLoading(false);
    }, (error) => {
      console.error('Erro no snapshot:', error);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Salvar lote: tenta enviar ao Firestore, se falhar salva como pendente
  const addBatch = async (batch: Batch) => {
    const netInfo = await NetInfo.fetch();
    const isConnected = netInfo.isConnected && netInfo.isInternetReachable;

    if (isConnected) {
      try {
        await addDoc(collection(db, 'batches'), {
          batchId: batch.batchId,
          modules: batch.modules,
          createdAt: batch.createdAt,
        });
        return; // Sucesso, não salva localmente
      } catch (error) {
        console.error('Erro ao salvar no Firebase:', error);
      }
    }
    // Salvar como pendente
    const pendingBatch = { ...batch, synced: false };
    const storedPending = await AsyncStorage.getItem('@pending_batches');
    const pendingList: Batch[] = storedPending ? JSON.parse(storedPending) : [];
    pendingList.push(pendingBatch);
    await AsyncStorage.setItem('@pending_batches', JSON.stringify(pendingList));
    setBatches(prev => [...prev, pendingBatch]);
    Alert.alert('Salvo offline', 'Lote será sincronizado quando a conexão voltar.');
  };

  // Sincronizar lotes pendentes (com opção de mostrar alertas)
  const syncPendingBatches = async (showAlert: boolean = true): Promise<void> => {
    const netInfo = await NetInfo.fetch();
    if (!netInfo.isConnected || !netInfo.isInternetReachable) {
      if (showAlert) Alert.alert('Sem conexão', 'Conecte-se à internet e tente novamente.');
      return;
    }
    const storedPending = await AsyncStorage.getItem('@pending_batches');
    const pendingList: Batch[] = storedPending ? JSON.parse(storedPending) : [];
    if (pendingList.length === 0) {
      if (showAlert) Alert.alert('Nada a sincronizar', 'Todos os lotes já estão no servidor.');
      return;
    }
    let successCount = 0;
    for (const batch of pendingList) {
      try {
        await addDoc(collection(db, 'batches'), {
          batchId: batch.batchId,
          modules: batch.modules,
          createdAt: batch.createdAt,
        });
        successCount++;
      } catch (error) {
        console.error('Erro ao sincronizar lote:', batch.batchId, error);
      }
    }
    const remaining = pendingList.slice(successCount);
    await AsyncStorage.setItem('@pending_batches', JSON.stringify(remaining));
    if (showAlert) Alert.alert('Sincronização concluída', `${successCount} lote(s) enviado(s).`);
  };

  // Sincronização automática quando a internet voltar (sem alertas)
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.isConnected && state.isInternetReachable) {
        syncPendingBatches(false); // silencioso
      }
    });
    return () => unsubscribe();
  }, []);

  // Funções do lote corrente (inalteradas)
  const createNewBatch = async (): Promise<boolean> => {
    if (currentBatchId !== null && currentModules.length > 0 && currentModules.length < 30) {
      Alert.alert('Lote em andamento', 'Finalize ou cancele o lote atual antes de criar um novo.');
      return false;
    }
    let nextId = 1;
    const allBatchIds = batches.map(b => parseInt(b.batchId, 10)).filter(id => !isNaN(id));
    if (allBatchIds.length > 0) {
      nextId = Math.max(...allBatchIds) + 1;
    }
    setCurrentBatchId(nextId.toString());
    setCurrentModules([]);
    return true;
  };

  const addModuleToCurrentBatch = async (code: string): Promise<boolean> => {
    if (currentBatchId === null) {
      Alert.alert('Nenhum lote ativo', 'Clique em "Criar lote" para começar.');
      return false;
    }
    if (currentModules.length >= 30) {
      Alert.alert('Lote cheio', 'Este lote já possui 30 módulos.');
      return false;
    }
    if (currentModules.some(mod => mod.code === code)) {
      Alert.alert('Código duplicado', 'Este código já foi inserido neste lote.');
      return false;
    }
    const newId = currentModules.length + 1;
    const newModule: Module = {
      id: newId,
      code,
      timestamp: formatDateTime(new Date()),
    };
    setCurrentModules(prev => [...prev, newModule]);
    return true;
  };

  const resetCurrentBatch = () => {
    setCurrentBatchId(null);
    setCurrentModules([]);
  };

  return (
    <BatchesContext.Provider value={{ batches, addBatch, loading, syncPendingBatches }}>
      <CurrentBatchContext.Provider
        value={{
          currentBatchId,
          currentModules,
          createNewBatch,
          addModuleToCurrentBatch,
          resetCurrentBatch,
        }}
      >
        {children}
      </CurrentBatchContext.Provider>
    </BatchesContext.Provider>
  );
};

// ---------- Tela Registrar Módulos ----------
const CurrentBatchScreen = ({ navigation }: any) => {
  const { syncPendingBatches } = useBatches();
  const {
    currentBatchId,
    currentModules,
    createNewBatch,
    addModuleToCurrentBatch,
    resetCurrentBatch,
  } = useCurrentBatch();
  const { addBatch } = useBatches();

  const [codeInput, setCodeInput] = useState('');
  const inputRef = useRef<TextInput>(null);
  const isFull = currentModules.length === 30;
  const hasActiveBatch = currentBatchId !== null;

  const finalizeBatchWithModules = async (batchId: string, modules: Module[]) => {
    const newBatch: Batch = {
      batchId: batchId,
      modules: modules,
      createdAt: formatDateTime(new Date()),
      synced: false,
    };
    await addBatch(newBatch);
    resetCurrentBatch();
    Alert.alert('Lote salvo!', `Lote ${batchId} foi finalizado com sucesso.`);
    navigation.navigate('Módulos');
  };

  const handleAddCode = async () => {
    const trimmedCode = codeInput.trim();
    if (!trimmedCode) {
      Alert.alert('Código vazio', 'Digite um código numérico.');
      inputRef.current?.focus();
      return;
    }
    if (trimmedCode.length !== 14) {
      Alert.alert('Tamanho inválido', 'O código deve ter exatamente 14 números.');
      setCodeInput('');
      inputRef.current?.focus();
      return;
    }
    if (!hasActiveBatch) {
      Alert.alert('Nenhum lote', 'Clique em "Criar lote" para começar.');
      setCodeInput('');
      inputRef.current?.focus();
      return;
    }
    if (isFull) {
      Alert.alert('Lote cheio', 'Este lote já está completo. Finalize-o para criar outro.');
      setCodeInput('');
      inputRef.current?.focus();
      return;
    }

    const willBeFull = currentModules.length + 1 === 30;
    try {
      const success = await addModuleToCurrentBatch(trimmedCode);
      if (success) {
        setCodeInput('');
        inputRef.current?.focus();
        if (willBeFull) {
          const newModule: Module = {
            id: currentModules.length + 1,
            code: trimmedCode,
            timestamp: formatDateTime(new Date()),
          };
          const finalModules = [...currentModules, newModule];
          await finalizeBatchWithModules(currentBatchId!, finalModules);
        }
      } else {
        setCodeInput('');
        inputRef.current?.focus();
      }
    } catch (error) {
      console.error(error);
      Alert.alert('Erro', 'Ocorreu um erro inesperado. Tente novamente.');
      setCodeInput('');
      inputRef.current?.focus();
    }
  };

  const handleCancelBatch = () => {
    if (currentModules.length > 0) {
      Alert.alert(
        'Cancelar lote',
        'Tem certeza? Todos os módulos inseridos serão perdidos.',
        [
          { text: 'Não', style: 'cancel' },
          {
            text: 'Sim',
            style: 'destructive',
            onPress: () => {
              resetCurrentBatch();
              setCodeInput('');
            },
          },
        ]
      );
    } else {
      resetCurrentBatch();
      setCodeInput('');
    }
  };

  return (
    <View style={styles.screen}>

      <View style={styles.codeInputContainer}>
        <TextInput
          ref={inputRef}
          style={styles.codeInput}
          placeholder="Código (apenas números)"
          keyboardType="numeric"
          maxLength={14}
          value={codeInput}
          onChangeText={setCodeInput}
          onSubmitEditing={handleAddCode}
          autoCapitalize="none"
          autoCorrect={false}
          editable={true}
        />
        <Button title="Adicionar" onPress={handleAddCode} disabled={isFull} />
      </View>

      {/* Primeira linha: criar lote ou mostrar lote atual + cancelar */}
      <View style={styles.headerRow}>
        {hasActiveBatch ? (
          <>
            <Text style={styles.batchLabel}>Lote atual: {currentBatchId}</Text>
            <Button title="Cancelar lote" onPress={handleCancelBatch} color="#d32f2f" />
          </>
        ) : (
          <Button title="Criar lote" onPress={createNewBatch} />
        )}
      </View>

      {/* Segunda linha: contagem e botão sincronizar */}
      <View style={styles.headerRow}>
        <Text style={styles.counter}>Módulos: {currentModules.length}/30</Text>
        <Button title="Sincronizar" onPress={() => syncPendingBatches()} />
      </View>



      {currentModules.length > 0 && (
        <>
          <Text style={styles.tableTitle}>Módulos inseridos</Text>
          <FlatList
            data={currentModules}
            keyExtractor={(item) => item.id.toString()}
            renderItem={({ item }) => (
              <View style={styles.tableRow}>
                <Text style={styles.cellId}>{item.id}</Text>
                <Text style={styles.cellCode}>{item.code}</Text>
                <Text style={styles.cellDate}>{item.timestamp}</Text>
              </View>
            )}
            ListHeaderComponent={() => (
              <View style={[styles.tableRow, styles.tableHeader]}>
                <Text style={styles.cellId}>ID</Text>
                <Text style={styles.cellCode}>Código</Text>
                <Text style={styles.cellDate}>Data/Hora</Text>
              </View>
            )}
          />
        </>
      )}

      {isFull && hasActiveBatch && (
        <View style={styles.finishButton}>
          <Button title="Finalizar Lote" onPress={() => finalizeBatchWithModules(currentBatchId!, currentModules)} />
        </View>
      )}
    </View>
  );
};

// ---------- Tela Módulos ----------
const ModulesScreen = () => {
  const { batches, loading, syncPendingBatches } = useBatches();
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);

  const openDetails = (batch: Batch) => {
    setSelectedBatch(batch);
    setModalVisible(true);
  };

  if (loading && batches.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1976d2" />
        <Text>Carregando lotes...</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.syncHeader}>
        <Text style={styles.syncTitle}>Lotes finalizados</Text>
        <Button title="Sincronizar" onPress={() => syncPendingBatches()} />
      </View>
      <FlatList
        data={batches}
        keyExtractor={(item, index) => item.id || index.toString()}
        renderItem={({ item }) => (
          <View style={[styles.card, !item.synced && styles.pendingCard]}>
            <Text style={styles.cardTitle}>
              Lote {item.batchId} {!item.synced && '⏳ (pendente)'}
            </Text>
            <Text style={styles.cardSubtitle}>
              {item.modules.length} módulos • Criado em {item.createdAt}
            </Text>
            <Button title="Detalhes" onPress={() => openDetails(item)} />
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            Nenhum lote finalizado ainda. Vá para "Registrar lote" e complete um lote de 30.
          </Text>
        }
      />
      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>Detalhes do Lote {selectedBatch?.batchId}</Text>
          <FlatList
            data={selectedBatch?.modules}
            keyExtractor={(item) => item.id.toString()}
            renderItem={({ item }) => (
              <View style={styles.tableRow}>
                <Text style={styles.cellId}>{item.id}</Text>
                <Text style={styles.cellCode}>{item.code}</Text>
                <Text style={styles.cellDate}>{item.timestamp}</Text>
              </View>
            )}
            ListHeaderComponent={() => (
              <View style={[styles.tableRow, styles.tableHeader]}>
                <Text style={styles.cellId}>ID</Text>
                <Text style={styles.cellCode}>Código</Text>
                <Text style={styles.cellDate}>Data/Hora</Text>
              </View>
            )}
          />
          <Button title="Fechar" onPress={() => setModalVisible(false)} />
        </View>
      </Modal>
    </View>
  );
};

// ---------- Navegação ----------
const Tab = createBottomTabNavigator();
const AppNavigator = () => (
  <Tab.Navigator
    screenOptions={{
      tabBarIcon: () => null,
      headerShown: true,
      tabBarLabelStyle: { fontSize: 18, fontWeight: 'bold' },
      tabBarStyle: { height: 130, paddingBottom: 0, paddingTop: 0 },
      tabBarItemStyle: { marginTop: -20 },
    }}
  >
    <Tab.Screen name="Registrar lote" component={CurrentBatchScreen} />
    <Tab.Screen name="Módulos" component={ModulesScreen} />
  </Tab.Navigator>
);

// ---------- App principal ----------
export default function App() {
  return (
    <AppProvider>
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </AppProvider>
  );
}

// ---------- Estilos ----------
const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: '#f5f5f5' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  syncHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  syncTitle: { fontSize: 18, fontWeight: 'bold' },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 8,
    elevation: 2,
  },
  batchLabel: { fontSize: 16, fontWeight: 'bold', color: '#1976d2' },
  counter: { fontSize: 16, fontWeight: 'bold' },
  codeInputContainer: { flexDirection: 'row', marginBottom: 20, gap: 8 },
  codeInput: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 8, backgroundColor: '#fff' },
  tableTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  tableRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ddd', backgroundColor: '#fff' },
  tableHeader: { backgroundColor: '#e0e0e0', marginTop: 8 },
  cellId: { width: 50, fontWeight: 'bold', textAlign: 'center' },
  cellCode: { flex: 2, paddingLeft: 8 },
  cellDate: { flex: 2, textAlign: 'right', paddingRight: 8 },
  finishButton: { marginTop: 20 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 12, elevation: 3 },
  pendingCard: { backgroundColor: '#fff9c4' },
  cardTitle: { fontSize: 18, fontWeight: 'bold' },
  cardSubtitle: { fontSize: 14, color: '#555', marginVertical: 6 },
  emptyText: { textAlign: 'center', marginTop: 40, fontSize: 16, color: '#888' },
  modalContainer: { flex: 1, padding: 20, backgroundColor: '#fff' },
  modalTitle: { fontSize: 22, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
});
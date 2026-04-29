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
import { Picker } from '@react-native-picker/picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { db } from './firebaseConfig';
import { collection, query, orderBy, onSnapshot, addDoc } from 'firebase/firestore';
import NetInfo from '@react-native-community/netinfo';

// ==================== CONSTANTES ====================
const USINAS = ['GD-1', 'GD-2', 'GD-3', 'GD-4', 'PARAOPEBA-1', 'PARAOPEBA-2'];

const SUBAREAS: Record<string, string[]> = {
  'GD-1': ['UFV 1', 'UFV 2', 'UFV 3'],
  'GD-2': ['UFV 1', 'UFV 2', 'UFV 3'],
  'GD-3': ['UFV 1', 'UFV 2', 'UFV 3'],
  'GD-4': ['UFV 1', 'UFV 2', 'UFV 3'],
  'PARAOPEBA-1': ['A', 'B', 'C'],
  'PARAOPEBA-2': ['A', 'B', 'C'],
};

const MAX_MODULES: Record<string, number> = {
  'GD-1': 30,
  'GD-2': 30,
  'GD-3': 45,
  'GD-4': 45,
  'PARAOPEBA-1': 30,
  'PARAOPEBA-2': 30,
};

// Gera o nome da coleção: GD-1-UFV-1, GD-1-UFV-2, etc.
const getCollectionName = (usina: string, subarea: string) =>
  `${usina}-${subarea.replace(/ /g, '-')}`;

// Lista de todas as coleções que serão escutadas
const ALL_COLLECTIONS = USINAS.flatMap((usina) =>
  SUBAREAS[usina].map((sub) => getCollectionName(usina, sub))
);

// ==================== TIPAGENS ====================
type Module = {
  id: number;
  code: string;
  timestamp: string;
};

type Batch = {
  id?: string;
  batchId: string;
  usina: string;
  subarea: string;
  modules: Module[];
  createdAt: string;
  synced?: boolean;
  maxModules: number;
};

type BatchesContextType = {
  batches: Batch[];
  addBatch: (batch: Batch) => Promise<void>;
  loading: boolean;
  syncPendingBatches: (showAlert?: boolean) => Promise<void>;
};

type CurrentBatchContextType = {
  currentBatchId: string | null;
  currentModules: Module[];
  currentUsina: string;
  currentSub: string;
  currentMaxModules: number;
  createNewBatch: (usina: string, sub: string, maxModules: number) => Promise<boolean>;
  addModuleToCurrentBatch: (code: string) => Promise<boolean>;
  resetCurrentBatch: () => void;
};

// ==================== CONTEXTOS ====================
const BatchesContext = createContext<BatchesContextType | undefined>(undefined);
const CurrentBatchContext = createContext<CurrentBatchContextType | undefined>(undefined);

const useBatches = () => {
  const ctx = useContext(BatchesContext);
  if (!ctx) throw new Error('useBatches deve estar dentro de um BatchesProvider');
  return ctx;
};

const useCurrentBatch = () => {
  const ctx = useContext(CurrentBatchContext);
  if (!ctx) throw new Error('useCurrentBatch deve estar dentro de um CurrentBatchProvider');
  return ctx;
};

// ==================== PROVIDER ====================
const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [currentModules, setCurrentModules] = useState<Module[]>([]);
  const [currentUsina, setCurrentUsina] = useState('');
  const [currentSub, setCurrentSub] = useState('');
  const [currentMaxModules, setCurrentMaxModules] = useState(0);
  const [loading, setLoading] = useState(true);

  // Carrega cache local
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

  // Escuta TODAS as coleções (usina+subárea)
  useEffect(() => {
    const unsubscribes: (() => void)[] = [];

    ALL_COLLECTIONS.forEach((collectionName) => {
      const q = query(collection(db, collectionName), orderBy('createdAt', 'desc'));
      const unsubscribe = onSnapshot(q, async (snapshot) => {
        const firestoreBatches: Batch[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          firestoreBatches.push({
            id: doc.id,
            batchId: data.batchId,
            usina: data.usina,
            subarea: data.subarea,
            modules: data.modules,
            createdAt: data.createdAt,
            synced: true,
            maxModules: data.maxModules,
          });
        });

        setBatches((prev) => {
          // Remove lotes sincronizados dessa coleção e insere os novos
          const other = prev.filter(
            (b) =>
              getCollectionName(b.usina, b.subarea) !== collectionName ||
              !b.synced
          );
          const merged = [...other, ...firestoreBatches];
          AsyncStorage.setItem(
            '@batches_cache',
            JSON.stringify(merged.filter((b) => b.synced))
          );
          return merged.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        });

        setLoading(false);
      });

      unsubscribes.push(unsubscribe);
    });

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, []);

  // Salvar lote na coleção correta
  const addBatch = async (batch: Batch) => {
    const netInfo = await NetInfo.fetch();
    const isConnected = netInfo.isConnected && netInfo.isInternetReachable;
    const collectionName = getCollectionName(batch.usina, batch.subarea);

    if (isConnected) {
      try {
        await addDoc(collection(db, collectionName), {
          batchId: batch.batchId,
          usina: batch.usina,
          subarea: batch.subarea,
          modules: batch.modules,
          createdAt: batch.createdAt,
          maxModules: batch.maxModules,
        });
        return;
      } catch (error) {
        console.error('Erro ao salvar no Firebase:', error);
      }
    }

    const pendingBatch = { ...batch, synced: false };
    const storedPending = await AsyncStorage.getItem('@pending_batches');
    const pendingList: Batch[] = storedPending ? JSON.parse(storedPending) : [];
    pendingList.push(pendingBatch);
    await AsyncStorage.setItem('@pending_batches', JSON.stringify(pendingList));
    setBatches((prev) => [...prev, pendingBatch]);
    Alert.alert('Salvo offline', 'Lote será sincronizado quando a conexão voltar.');
  };

  // Sincronizar pendentes
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
        const collectionName = getCollectionName(batch.usina, batch.subarea);
        await addDoc(collection(db, collectionName), {
          batchId: batch.batchId,
          usina: batch.usina,
          subarea: batch.subarea,
          modules: batch.modules,
          createdAt: batch.createdAt,
          maxModules: batch.maxModules,
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

  // Sincronização automática quando a internet voltar
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable) {
        syncPendingBatches(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // Criar novo lote (batchId por combinação usina+subárea)
  const createNewBatch = async (usina: string, sub: string, maxModules: number): Promise<boolean> => {
    if (currentBatchId !== null && currentModules.length > 0 && currentModules.length < currentMaxModules) {
      Alert.alert('Lote em andamento', 'Finalize ou cancele o lote atual antes de criar um novo.');
      return false;
    }

    // batchId sequencial por usina+subárea (baseado no estado local)
    const relevant = batches.filter((b) => b.usina === usina && b.subarea === sub);
    let nextId = 1;
    if (relevant.length > 0) {
      const ids = relevant.map((b) => parseInt(b.batchId, 10)).filter((id) => !isNaN(id));
      if (ids.length > 0) nextId = Math.max(...ids) + 1;
    }

    setCurrentBatchId(nextId.toString());
    setCurrentUsina(usina);
    setCurrentSub(sub);
    setCurrentMaxModules(maxModules);
    setCurrentModules([]);
    return true;
  };

  const addModuleToCurrentBatch = async (code: string): Promise<boolean> => {
    if (currentBatchId === null) {
      Alert.alert('Nenhum lote ativo', 'Clique em "Criar lote" para começar.');
      return false;
    }
    if (currentModules.length >= currentMaxModules) {
      Alert.alert('Lote cheio', `Este lote já possui ${currentMaxModules} módulos.`);
      return false;
    }
    if (currentModules.some((mod) => mod.code === code)) {
      Alert.alert('Código duplicado', 'Este código já foi inserido neste lote.');
      return false;
    }
    const newId = currentModules.length + 1;
    const newModule: Module = {
      id: newId,
      code,
      timestamp: formatDateTime(new Date()),
    };
    setCurrentModules((prev) => [...prev, newModule]);
    return true;
  };

  const resetCurrentBatch = () => {
    setCurrentBatchId(null);
    setCurrentModules([]);
    setCurrentUsina('');
    setCurrentSub('');
    setCurrentMaxModules(0);
  };

  return (
    <BatchesContext.Provider value={{ batches, addBatch, loading, syncPendingBatches }}>
      <CurrentBatchContext.Provider
        value={{
          currentBatchId,
          currentModules,
          currentUsina,
          currentSub,
          currentMaxModules,
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

// ==================== FORMATADOR DE DATA ====================
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

// ==================== TELA REGISTRAR MÓDULOS ====================
const CurrentBatchScreen = ({ navigation }: any) => {
  const { syncPendingBatches, addBatch } = useBatches();
  const {
    currentBatchId,
    currentModules,
    currentUsina,
    currentSub,
    currentMaxModules,
    createNewBatch,
    addModuleToCurrentBatch,
    resetCurrentBatch,
  } = useCurrentBatch();

  const [selectedUsina, setSelectedUsina] = useState('');
  const [selectedSub, setSelectedSub] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const inputRef = useRef<TextInput>(null);

  const isFull = currentBatchId !== null && currentModules.length >= currentMaxModules;
  const hasActiveBatch = currentBatchId !== null;

  const finalizeBatchWithModules = async (batchId: string, modules: Module[]) => {
    const newBatch: Batch = {
      batchId: batchId,
      usina: currentUsina,
      subarea: currentSub,
      modules: modules,
      createdAt: formatDateTime(new Date()),
      synced: false,
      maxModules: currentMaxModules,
    };
    await addBatch(newBatch);
    resetCurrentBatch();
    setSelectedUsina('');
    setSelectedSub('');
    Alert.alert('Lote salvo!', `Lote ${batchId} finalizado.`);
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
      Alert.alert('Lote cheio', `Este lote já está completo. Finalize-o para criar outro.`);
      setCodeInput('');
      inputRef.current?.focus();
      return;
    }

    const willBeFull = currentModules.length + 1 === currentMaxModules;
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
      Alert.alert('Erro', 'Ocorreu um erro inesperado.');
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
              setSelectedUsina('');
              setSelectedSub('');
              setCodeInput('');
            },
          },
        ]
      );
    } else {
      resetCurrentBatch();
      setSelectedUsina('');
      setSelectedSub('');
      setCodeInput('');
    }
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.label}>Qual usina você está?</Text>
      <View style={styles.pickerContainer}>
        <Picker
          selectedValue={selectedUsina}
          onValueChange={(value) => {
            setSelectedUsina(value);
            setSelectedSub('');
          }}
          enabled={!hasActiveBatch}
        >
          <Picker.Item label="Selecione uma usina..." value="" />
          {USINAS.map((u) => (
            <Picker.Item key={u} label={u} value={u} />
          ))}
        </Picker>
      </View>

      {selectedUsina !== '' && (
        <>
          <Text style={styles.label}>Selecione a subárea:</Text>
          <View style={styles.pickerContainer}>
            <Picker
              selectedValue={selectedSub}
              onValueChange={setSelectedSub}
              enabled={!hasActiveBatch}
            >
              <Picker.Item label="Selecione..." value="" />
              {SUBAREAS[selectedUsina]?.map((sub) => (
                <Picker.Item key={sub} label={sub} value={sub} />
              ))}
            </Picker>
          </View>
        </>
      )}

      {!hasActiveBatch && selectedUsina !== '' && selectedSub !== '' && (
        <Button
          title="Criar lote"
          onPress={() => createNewBatch(selectedUsina, selectedSub, MAX_MODULES[selectedUsina])}
        />
      )}

      {hasActiveBatch && (
        <>
          <View style={styles.codeInputContainer}>
            <TextInput
              ref={inputRef}
              style={styles.codeInput}
              placeholder="Código (14 números)"
              keyboardType="numeric"
              maxLength={14}
              value={codeInput}
              onChangeText={setCodeInput}
              onSubmitEditing={handleAddCode}
            />
            <Button title="Adicionar" onPress={handleAddCode} disabled={isFull} />
          </View>

          <View style={styles.headerRow}>
            <Text style={styles.batchLabel}>Lote: {currentBatchId}</Text>
            <Text style={styles.usinaLabel}>{currentUsina} - {currentSub}</Text>
            <Button title="Cancelar lote" onPress={handleCancelBatch} color="#d32f2f" />
          </View>

          <View style={styles.headerRow}>
            <Text style={styles.counter}>
              Módulos: {currentModules.length}/{currentMaxModules}
            </Text>
            <Button title="Sincronizar" onPress={() => syncPendingBatches()} />
          </View>

          {currentModules.length > 0 && (
            <>
              <Text style={styles.tableTitle}>Módulos inseridos</Text>
              <FlatList
                data={[...currentModules].reverse()}
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

          {isFull && (
            <View style={styles.finishButton}>
              <Button title="Finalizar Lote" onPress={() => finalizeBatchWithModules(currentBatchId!, currentModules)} />
            </View>
          )}
        </>
      )}
    </View>
  );
};

// ==================== TELA MÓDULOS ====================
const ModulesScreen = () => {
  const { batches, loading, syncPendingBatches } = useBatches();
  const [usinaModalVisible, setUsinaModalVisible] = useState(false);
  const [selectedUsina, setSelectedUsina] = useState('');
  const [loteModalVisible, setLoteModalVisible] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);

  const batchesDaUsina = selectedUsina
    ? batches.filter((b) => b.usina === selectedUsina)
    : [];

  const openUsinaLotes = (usina: string) => {
    setSelectedUsina(usina);
    setUsinaModalVisible(true);
  };

  const openBatchDetails = (batch: Batch) => {
    setSelectedBatch(batch);
    setLoteModalVisible(true);
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
        <Text style={styles.syncTitle}>Usinas</Text>
        <Button title="Sincronizar" onPress={() => syncPendingBatches()} />
      </View>

      <FlatList
        data={USINAS}
        keyExtractor={(item) => item}
        renderItem={({ item: usina }) => {
          const lotesDaUsina = batches.filter((b) => b.usina === usina);
          const totalModulos = lotesDaUsina.reduce(
            (sum, b) => sum + b.modules.length, 0
          );
          const totalLotes = lotesDaUsina.length;

          return (
            <View style={styles.usinaCard}>
              <View style={styles.usinaHeader}>
                <Text style={styles.usinaTitle}>{usina}</Text>
                <Text style={styles.usinaStats}>
                  {totalLotes} lote(s) • {totalModulos} módulo(s)
                </Text>
              </View>
              <Button title="Ver lotes" onPress={() => openUsinaLotes(usina)} />
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Nenhuma usina disponível.</Text>
        }
      />

      <Modal visible={usinaModalVisible} animationType="slide" onRequestClose={() => setUsinaModalVisible(false)}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>Lotes de {selectedUsina}</Text>
          {batchesDaUsina.length === 0 ? (
            <Text style={styles.emptyText}>Nenhum lote encontrado.</Text>
          ) : (
            <FlatList
              data={batchesDaUsina}
              keyExtractor={(item, index) => item.id || index.toString()}
              renderItem={({ item }) => (
                <View style={[styles.card, !item.synced && styles.pendingCard]}>
                  <Text style={styles.cardTitle}>
                    {item.subarea} – Lote {item.batchId}
                    {!item.synced && ' ⏳'}
                  </Text>
                  <Text style={styles.cardSubtitle}>
                    {item.modules.length} módulos • {item.createdAt}
                  </Text>
                  <Button title="Detalhes" onPress={() => openBatchDetails(item)} />
                </View>
              )}
            />
          )}
          <View style={{ marginTop: 12 }}>
            <Button title="Fechar" onPress={() => setUsinaModalVisible(false)} />
          </View>
        </View>
      </Modal>

      <Modal visible={loteModalVisible} animationType="slide" onRequestClose={() => setLoteModalVisible(false)}>
        <View style={styles.modalContainer}>
          <Text style={styles.modalTitle}>Lote {selectedBatch?.batchId} ({selectedBatch?.subarea})</Text>
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
          <View style={{ marginTop: 12 }}>
            <Button title="Fechar" onPress={() => setLoteModalVisible(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
};

// ==================== NAVEGAÇÃO ====================
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

export default function App() {
  return (
    <AppProvider>
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </AppProvider>
  );
}

// ==================== ESTILOS ====================
const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: '#f5f5f5' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  syncHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  syncTitle: { fontSize: 18, fontWeight: 'bold' },
  label: { fontSize: 16, fontWeight: 'bold', marginTop: 8, marginBottom: 4 },
  pickerContainer: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
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
  usinaLabel: { fontSize: 14, color: '#555' },
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
  // Novos estilos para usinas
  usinaCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    elevation: 3,
  },
  usinaHeader: {
    marginBottom: 8,
  },
  usinaTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1976d2',
  },
  usinaStats: {
    fontSize: 14,
    color: '#555',
    marginTop: 4,
  },
});
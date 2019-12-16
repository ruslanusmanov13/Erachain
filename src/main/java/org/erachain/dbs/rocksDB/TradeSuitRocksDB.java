package org.erachain.dbs.rocksDB;

import com.google.common.primitives.Ints;
import com.google.common.primitives.Longs;
import lombok.extern.slf4j.Slf4j;
import org.erachain.controller.Controller;
import org.erachain.core.item.assets.Order;
import org.erachain.core.item.assets.Trade;
import org.erachain.core.transaction.Transaction;
import org.erachain.database.DBASet;
import org.erachain.datachain.TradeSuit;
import org.erachain.dbs.IteratorCloseable;
import org.erachain.dbs.rocksDB.common.RocksDbSettings;
import org.erachain.dbs.rocksDB.indexes.SimpleIndexDB;
import org.erachain.dbs.rocksDB.integration.DBRocksDBTableDBCommitedAsBath;
import org.erachain.dbs.rocksDB.transformation.ByteableTrade;
import org.erachain.dbs.rocksDB.transformation.tuples.ByteableTuple2LongLong;
import org.mapdb.DB;
import org.mapdb.Fun.Tuple2;
import org.rocksdb.ReadOptions;
import org.rocksdb.WriteOptions;

import java.util.ArrayList;

/**
 * Хранит сделки на бирже
 * Ключ: ссылка на иницатора + ссылка на цель
 * Значение - Сделка
 * Initiator DBRef (Long) + Target DBRef (Long) -> Trade
 */

@Slf4j
public class TradeSuitRocksDB extends DBMapSuit<Tuple2<Long, Long>, Trade> implements TradeSuit {

    private final String NAME_TABLE = "TRADES_TABLE";
    private final String tradesKeyPairIndexName = "tradesKeyPair";
    private final String tradesKeyWantIndexName = "tradesKeyWant";
    private final String tradesKeyHaveIndexName = "tradesKeyHave";
    private final String tradesKeyReverseIndexName = "tradesKeyReverse";

    SimpleIndexDB<Tuple2<Long, Long>, Trade, byte[]> pairIndex;
    SimpleIndexDB<Tuple2<Long, Long>, Trade, byte[]> wantIndex;
    SimpleIndexDB<Tuple2<Long, Long>, Trade, byte[]> haveIndex;
    SimpleIndexDB<Tuple2<Long, Long>, Trade, byte[]> reverseIndex;

    public TradeSuitRocksDB(DBASet databaseSet, DB database) {
        super(databaseSet, database, logger, false);
    }

    @Override
    public void openMap() {

        map = new DBRocksDBTableDBCommitedAsBath<>(new ByteableTuple2LongLong(), new ByteableTrade(),
                NAME_TABLE, indexes,
                RocksDbSettings.initCustomSettings(7, 64, 32,
                        256, 10,
                        1, 256, 32, false),
                new WriteOptions().setSync(true).setDisableWAL(false),
                new ReadOptions(),
                databaseSet, sizeEnable);
    }

    @Override
    protected void createIndexes() {
        // SIZE need count - make not empty LIST
        indexes = new ArrayList<>();

        ///////////////////////////// HERE PROTOCOL INDEXES

        if (Controller.getInstance().onlyProtocolIndexing)
            // NOT USE SECONDARY INDEXES
            return;

        //////////////// NOT PROTOCOL INDEXES

        pairIndex = new SimpleIndexDB<>(
                tradesKeyPairIndexName,
                (key, value) -> {
                    long have = value.getHaveKey();
                    long want = value.getWantKey();

                    /// нельзя! иначе строки длиньше тоже будет воспринимать как подходящие!
                    // byte[] buffer1 = TradeSuit.makeKey(have, want).getBytes(StandardCharsets.UTF_8);
                    ///byte[] buffer1 = TradeSuit.makeKey(have, want).getBytes(StandardCharsets.UTF_8);
                    //System.arraycopy(buffer1, 0, buffer, 0, buffer1.length);
                    //System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - value.getInitiator()),
                    //        0, buffer, buffer1.length, 8);
                    //System.arraycopy(Ints.toByteArray(Integer.MAX_VALUE - value.getSequence()),
                    //        0, buffer, buffer1.length + 8, 4);

                    byte[] filter = new byte[28];
                    makeKey(filter, have, want);
                    // обратная сортировка поэтому все вычитаем Однако тут по другому минусы учитываются - они больше чем положительные числа!
                    // поэтому нужно еще делать корректировку как у Чисел
                    System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - value.getInitiator()),
                            0, filter, 16, 8);
                    System.arraycopy(Ints.toByteArray(Integer.MAX_VALUE - value.getSequence()),
                            0, filter, 24, 4);

                    return filter;
                }, (result) -> result);

        haveIndex = new SimpleIndexDB<>(
                tradesKeyHaveIndexName,
                (key, value) -> {
                    byte[] buffer = new byte[20];
                    // обратная сортировка поэтому все вычитаем Однако тут по другому минусы учитываются - они больше чем положительные числа!
                    // поэтому нужно еще делать корректировку как у Чисел
                    System.arraycopy(Longs.toByteArray(value.getHaveKey()),
                            0, buffer, 0, 8);
                    System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - value.getInitiator()),
                            0, buffer, 8, 8);
                    System.arraycopy(Ints.toByteArray(Integer.MAX_VALUE - value.getSequence()),
                            0, buffer, 16, 4);
                    return buffer;
                }, (result) -> result);

        wantIndex = new SimpleIndexDB<>(
                tradesKeyWantIndexName,
                (key, value) -> {
                    byte[] buffer = new byte[20];
                    // обратная сортировка поэтому все вычитаем Однако тут по другому минусы учитываются - они больше чем положительные числа!
                    // поэтому нужно еще делать корректировку как у Чисел
                    System.arraycopy(Longs.toByteArray(value.getWantKey()),
                            0, buffer, 0, 8);
                    System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - value.getInitiator()),
                            0, buffer, 8, 8);
                    System.arraycopy(Ints.toByteArray(Integer.MAX_VALUE - value.getSequence()),
                            0, buffer, 16, 4);
                    return buffer;
                }, (result) -> result);

        reverseIndex = new SimpleIndexDB<>(
                tradesKeyReverseIndexName,
                (key, value) -> {
                    byte[] buffer = new byte[16];
                    System.arraycopy(Longs.toByteArray(key.b), 0, buffer, 0, 8);
                    System.arraycopy(Longs.toByteArray(key.a), 0, buffer, 8, 8);
                    return buffer;
                }, (result) -> result);

        indexes.add(pairIndex);
        indexes.add(haveIndex);
        indexes.add(wantIndex);
        indexes.add(reverseIndex);
    }

    static void makeKey(byte[] buffer, long have, long want) {

        if (have > want) {
            System.arraycopy(Longs.toByteArray(have), 0, buffer, 0, 8);
            System.arraycopy(Longs.toByteArray(want), 0, buffer, 8, 8);
        } else {
            System.arraycopy(Longs.toByteArray(want), 0, buffer, 0, 8);
            System.arraycopy(Longs.toByteArray(have), 0, buffer, 8, 8);
        }

    }

    public void add(Trade trade) {
        this.put(new Tuple2<>(trade.getInitiator(), trade.getTarget()), trade);
    }

    public void delete(Trade trade) {
        delete(new Tuple2<>(trade.getInitiator(), trade.getTarget()));
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getIterator(Order order) {
        return map.getIndexIteratorFilter(Longs.toByteArray(order.getId()), false, false);
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getIteratorByKeys(Long orderID) {
        // тут нужно не Индекс включать
        return map.getIndexIteratorFilter(Longs.toByteArray(orderID), false, false);
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getTargetsIterator(Long orderID) {
        return map.getIndexIteratorFilter(reverseIndex.getColumnFamilyHandle(), Longs.toByteArray(orderID), false, true);
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getHaveIterator(long have) {
        return map.getIndexIteratorFilter(haveIndex.getColumnFamilyHandle(), Longs.toByteArray(have), false, true);
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getWantIterator(long want) {
        return map.getIndexIteratorFilter(wantIndex.getColumnFamilyHandle(), Longs.toByteArray(want), false, true);
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getPairIteratorDesc(long have, long want) {
        byte[] filter = new byte[16];
        makeKey(filter, have, want);
        return map.getIndexIteratorFilter(pairIndex.getColumnFamilyHandle(), filter, false, true);
    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getPairHeightIterator(long have, long want, int startHeight, int stopHeight) {

        byte[] startBytes;
        if (startHeight > 0) {
            startBytes = new byte[20];
            makeKey(startBytes, have, want);
            System.arraycopy(Ints.toByteArray(Integer.MAX_VALUE - startHeight), 0, startBytes, 16, 4);
        } else {
            startBytes = new byte[16];
            makeKey(startBytes, have, want);
            //startBytes[16] = (byte) 255; // больше делаем 1 байт чтобы захватывать значения все в это Высоте
        }

        byte[] stopBytes;
        if (stopHeight > 0) {
            stopBytes = new byte[24];
            makeKey(stopBytes, have, want);
            // так как тут обратный отсчет то вычитаем со старта еще и все номера транзакций
            System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - Transaction.makeDBRef(stopHeight, 0)), 0, stopBytes, 16, 8);
            //stopBytes[24] = (byte) 255; // больше делаем 1 байт чтобы захватывать значения все в это Высоте
        } else {
            stopBytes = new byte[16];
            makeKey(stopBytes, have, want);
            // из-за того что тут RockStoreIteratorFilter(org.rocksdb.RocksIterator, boolean, boolean, byte[], byte[])
            // использует сравнение
            //stopBytes[16] = (byte) 255; // больше делаем 1 байт чтобы захватывать значения все в это Высоте
        }

        return map.getIndexIteratorFilter(pairIndex.getColumnFamilyHandle(), startBytes, stopBytes, false, true);

    }

    @Override
    public IteratorCloseable<Tuple2<Long, Long>> getPairOrderIDIterator(long have, long want, long startOrderID, long stopOrderID) {

        byte[] startBytes;
        if (startOrderID > 0) {
            startBytes = new byte[24];
            makeKey(startBytes, have, want);
            System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - startOrderID), 0, startBytes, 16, 8);
        } else {
            startBytes = new byte[16];
            makeKey(startBytes, have, want);
        }

        byte[] stopBytes;
        if (stopOrderID > 0) {
            stopBytes = new byte[24];
            makeKey(stopBytes, have, want);
            System.arraycopy(Longs.toByteArray(Long.MAX_VALUE - stopOrderID), 0, stopBytes, 16, 8);
            //stopBytes[24] = (byte) 255; // больше делаем 1 байт чтобы захватывать значения все Sequence
        } else {
            stopBytes = new byte[16];
            makeKey(stopBytes, have, want);
            //stopBytes[16] = (byte) 255; // больше делаем 1 байт чтобы захватывать значения все в это Высоте
        }

        return map.getIndexIteratorFilter(pairIndex.getColumnFamilyHandle(), startBytes, stopBytes, false, true);

    }
}

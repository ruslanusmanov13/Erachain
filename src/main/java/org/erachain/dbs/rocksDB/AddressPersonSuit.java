package org.erachain.dbs.rocksDB;

import lombok.extern.slf4j.Slf4j;
import org.erachain.core.block.Block;
import org.erachain.database.DBASet;
import org.erachain.datachain.BlocksSuit;
import org.erachain.dbs.rocksDB.common.RocksDbSettings;
import org.erachain.dbs.rocksDB.integration.DBRocksDBTableDBCommitedAsBath;
import org.erachain.dbs.rocksDB.integration.DBRocksDBTableTransactionSingle;
import org.erachain.dbs.rocksDB.transformation.ByteableBlock;
import org.erachain.dbs.rocksDB.transformation.ByteableInteger;
import org.mapdb.DB;
import org.rocksdb.ReadOptions;
import org.rocksdb.WriteOptions;

import java.util.ArrayList;

@Slf4j
public class AddressPersonSuit extends DBMapSuit<Integer, Block> implements BlocksSuit {

    private final String NAME_TABLE = "BLOCKS_TABLE";

    public AddressPersonSuit(DBASet databaseSet, DB database) {
        super(databaseSet, database, logger, false);
    }

    @Override
    public void openMap() {

        if (true) {
            map = new DBRocksDBTableDBCommitedAsBath<>(new ByteableInteger(), new ByteableBlock(),
                    NAME_TABLE, indexes,
                    RocksDbSettings.initCustomSettings(7, 64, 32,
                            256, 10,
                            1, 256, 32, false),
                    new WriteOptions().setSync(true).setDisableWAL(false),
                    new ReadOptions(),
                    databaseSet, sizeEnable);
        } else {
            map = new DBRocksDBTableTransactionSingle<>(new ByteableInteger(), new ByteableBlock(), NAME_TABLE, indexes,
                    RocksDbSettings.initCustomSettings(7, 64, 32,
                            256, 10,
                            1, 256, 32, false),
                    new WriteOptions().setSync(true).setDisableWAL(false),
                    new ReadOptions(),
                    databaseSet, sizeEnable);
        }

    }

    @Override
    @SuppressWarnings({"unchecked", "rawtypes"})
    protected void createIndexes() {
        // SIZE need count - make not empty LIST
        indexes = new ArrayList<>();
    }

}
